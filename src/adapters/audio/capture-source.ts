import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { endianness, platform } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appError, isAppError, type AppError } from "@kernel/errors";
import type { CaptureSource, SourceItem } from "@modules/perception/audio";
import { err, ok, type Result } from "neverthrow";

import { FrameDecoder } from "./protocol.js";

const KNOWN_STAGES = new Set([
  "default-output",
  "output-uid",
  "create-tap",
  "tap-uid",
  "tap-format",
  "unsupported-format",
  "create-aggregate",
  "taplist-size",
  "taplist-get",
  "taplist-set",
  "create-ioproc",
  "start",
  "signal",
  "unsupported-os",
  "unsupported-platform",
  "invalid-buffer",
  "unsupported-buffer-layout",
  "teardown",
  "shutdown",
]);

const FAILURE_STAGES = new Set([...KNOWN_STAGES].filter((stage) => stage !== "signal"));

const STARTUP_TIMEOUT_MS = 5_000;
const EXIT_GRACE_MS = 500;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const STOP_SIGNAL_WAIT_MS = 2_000;
const DISPOSE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFERED_BYTES = 4_194_304;
const RESUME_BYTES = 1_048_576;

export function resolveHelperPath(
  env: Readonly<Record<string, string | undefined>>,
  execFileUrl: string,
): Result<string, AppError> {
  const override = env["URBUDDY_AUDIO_HELPER"];
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      return err(appError("VALIDATION_FAILED", "audio helper override must be absolute"));
    }
    return checkExecutable(override);
  }
  let dir = dirname(fileURLToPath(execFileUrl));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, "native", "audio-capture-macos", "bin", "urbuddy-audio-capture");
    const checked = checkExecutable(candidate);
    if (checked.isOk()) {
      return checked;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return err(appError("RESOURCE_ACQUIRE_FAILED", "audio helper not found"));
}

export function resolveBundledHelperPath(
  env: Readonly<Record<string, string | undefined>>,
): Result<string, AppError> {
  return resolveHelperPath(env, import.meta.url);
}

function checkExecutable(path: string): Result<string, AppError> {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return err(appError("RESOURCE_ACQUIRE_FAILED", "audio helper not found"));
  }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    return err(appError("RESOURCE_ACQUIRE_FAILED", "audio helper not available"));
  }
  return ok(path);
}

export interface SpawnAudioSourceInput {
  readonly helperPath: string;
  readonly syntheticFrames?: number;
  readonly maxBufferedBytes?: number;
  readonly ringSlots?: number;
  readonly shutdownTimeoutMs?: number;
  readonly platformName?: string;
}

export function parseStageLine(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const stage = (parsed as Record<string, unknown>)["stage"];
  if (typeof stage === "string" && KNOWN_STAGES.has(stage)) {
    return stage;
  }
  return undefined;
}

export function spawnAudioSource(input: SpawnAudioSourceInput): Result<CaptureSource, AppError> {
  if (endianness() !== "LE") {
    return err(appError("UNSUPPORTED", "audio capture requires a little-endian host"));
  }
  const host = input.platformName ?? platform();
  const synthetic = input.syntheticFrames ?? 0;
  if (host !== "darwin" && synthetic === 0) {
    return err(appError("UNSUPPORTED", "native audio capture requires macOS"));
  }
  if (!Number.isInteger(synthetic) || synthetic < 0 || synthetic > 100_000) {
    return err(appError("VALIDATION_FAILED", "synthetic frame count is out of range"));
  }
  const maxBuffered = input.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  if (!Number.isInteger(maxBuffered) || maxBuffered < 65_536) {
    return err(appError("VALIDATION_FAILED", "capture buffer bound is out of range"));
  }
  const shutdownTimeoutMs = input.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (
    !Number.isInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 500 ||
    shutdownTimeoutMs > 30000
  ) {
    return err(appError("VALIDATION_FAILED", "capture shutdown bound is out of range"));
  }
  const ringSlots = input.ringSlots;
  if (
    ringSlots !== undefined &&
    (!Number.isInteger(ringSlots) || ringSlots < 1 || ringSlots > 1024)
  ) {
    return err(appError("VALIDATION_FAILED", "helper ring size is out of range"));
  }
  const args = ["--chunk-frames", "2048"];
  if (synthetic > 0) {
    args.push("--synthetic-frames", String(synthetic));
  }
  if (ringSlots !== undefined) {
    args.push("--ring-slots", String(ringSlots));
  }
  const validated = checkExecutable(input.helperPath);
  if (validated.isErr()) {
    return err(validated.error);
  }
  try {
    const child = spawn(input.helperPath, args, { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    return ok(new ChildCaptureSource(child, maxBuffered, shutdownTimeoutMs));
  } catch (thrown: unknown) {
    return err(
      isAppError(thrown)
        ? thrown
        : appError("RESOURCE_ACQUIRE_FAILED", "audio helper failed to start"),
    );
  }
}

export class ChildCaptureSource implements CaptureSource {
  private readonly decoder = new FrameDecoder();
  private readonly queue: SourceItem[] = [];
  private queuedBytes = 0;
  private waiter:
    | {
        readonly signal: AbortSignal;
        readonly resolve: (outcome: Result<SourceItem | undefined, AppError>) => void;
      }
    | undefined;
  private fatal: AppError | undefined;
  private protocolBroken: AppError | undefined;
  private failureStage: string | undefined;
  private streamEnded = false;
  private endWaiters: Array<() => void> = [];
  private sawEnd = false;
  private childExited: number | null | undefined;
  private childSignal: NodeJS.Signals | null | undefined;
  private stage: string | undefined;
  private stderrTail = "";
  private paused = false;
  private consuming = false;
  private ready = false;
  private stopSent = false;
  private disposePromise: Promise<Result<void, AppError>> | undefined;
  private readonly startupTimer: ReturnType<typeof setTimeout>;
  private shutdownTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly maxBuffered: number,
    private readonly shutdownTimeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  ) {
    this.startupTimer = setTimeout(() => {
      if (!this.ready) {
        this.fail(
          appError(
            "RESOURCE_ACQUIRE_FAILED",
            `audio helper did not become ready${this.stageSuffix()}`,
          ),
        );
      }
    }, STARTUP_TIMEOUT_MS);
    child.stdout?.on("data", (data: Buffer) => this.onData(data));
    child.stdout?.on("end", () => this.onStreamEnd());
    child.stdout?.on("error", () => this.onStreamEnd());
    child.stdout?.on("close", () => this.onStreamEnd());
    child.stderr?.on("data", (data: Buffer) => this.onStderr(data));
    child.on("error", () => {
      this.fail(appError("RESOURCE_ACQUIRE_FAILED", "audio helper failed to start"));
    });
    child.on("close", (code, signal) => {
      this.childExited = code;
      this.childSignal = signal;
      if (!this.streamEnded) {
        this.onStreamEnd();
      }
      if (code !== 0 && code !== null && !this.ready) {
        this.fail(
          appError(
            "RESOURCE_ACQUIRE_FAILED",
            this.stage === undefined
              ? "audio helper exited before capture started"
              : `audio helper failed during ${this.stage}`,
          ),
        );
      } else if (code !== 0 && code !== null && !this.sawEnd) {
        this.fail(appError("INTERNAL", "audio helper exited unexpectedly"));
      }
    });
  }

  private markReady(): void {
    if (!this.ready) {
      this.ready = true;
      clearTimeout(this.startupTimer);
    }
  }

  private markEnded(): void {
    this.sawEnd = true;
    if (this.shutdownTimer !== undefined) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = undefined;
    }
  }

  private breakProtocol(message: string): void {
    if (this.protocolBroken === undefined) {
      this.protocolBroken = appError("VALIDATION_FAILED", message);
    }
    this.fail(this.protocolBroken);
  }

  private stageSuffix(): string {
    return this.failureStage === undefined ? "" : ` (helper reported ${this.failureStage})`;
  }

  private onStderr(data: Buffer): void {
    const text = data.toString("utf8");
    this.stderrTail = `${this.stderrTail}${text}`.slice(-2048);
    for (const line of text.split("\n")) {
      const stage = parseStageLine(line);
      if (stage !== undefined) {
        this.stage = stage;
        if (this.failureStage === undefined && FAILURE_STAGES.has(stage)) {
          this.failureStage = stage;
        }
      }
    }
  }

  private onData(data: Buffer): void {
    if (this.sawEnd) {
      this.breakProtocol("audio helper sent data after its end frame");
      return;
    }
    try {
      for (const item of this.decoder.push(data)) {
        if (this.sawEnd) {
          this.breakProtocol("audio helper sent data after its end frame");
          return;
        }
        this.markReady();
        if (item.type === "audio") {
          this.queuedBytes += item.chunk.samples.byteLength;
        }
        if (item.type === "end") {
          this.markEnded();
        }
        this.queue.push(item);
      }
    } catch (thrown: unknown) {
      this.fail(
        isAppError(thrown) ? thrown : appError("VALIDATION_FAILED", "audio frame decoding failed"),
      );
      return;
    }
    if (this.queuedBytes > this.maxBuffered && !this.paused) {
      this.paused = true;
      this.child.stdout?.pause();
    }
    this.drain();
  }

  private onStreamEnd(): void {
    this.streamEnded = true;
    if (this.sawEnd && this.decoder.hasPending) {
      this.breakProtocol("audio helper left a truncated frame after its end frame");
    }
    for (const wake of this.endWaiters.splice(0)) {
      wake();
    }
    this.drain();
  }

  private awaitStreamEnded(timeoutMs: number): Promise<void> {
    if (this.streamEnded) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const at = this.endWaiters.indexOf(done);
        if (at >= 0) {
          this.endWaiters.splice(at, 1);
        }
        resolve();
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.endWaiters.push(done);
    });
  }

  private fail(error: AppError): void {
    if (this.fatal === undefined) {
      this.fatal = error;
    }
    clearTimeout(this.startupTimer);
    this.drain();
  }

  private drain(): void {
    const waiter = this.waiter;
    if (waiter === undefined) {
      return;
    }
    if (waiter.signal.aborted) {
      this.waiter = undefined;
      waiter.resolve(err(appError("CANCELLED", "capture cancelled")));
      return;
    }
    const next = this.queue.shift();
    if (next !== undefined) {
      if (next.type === "audio") {
        this.queuedBytes -= next.chunk.samples.byteLength;
      }
      if (this.paused && this.queuedBytes < RESUME_BYTES) {
        this.paused = false;
        this.child.stdout?.resume();
      }
      this.waiter = undefined;
      waiter.resolve(ok(next));
      return;
    }
    if (this.fatal !== undefined) {
      this.waiter = undefined;
      waiter.resolve(err(this.fatal));
      return;
    }
    if (this.streamEnded) {
      this.waiter = undefined;
      waiter.resolve(ok(undefined));
    }
  }

  private take(signal: AbortSignal): Promise<Result<SourceItem | undefined, AppError>> {
    return new Promise((resolve) => {
      this.waiter = { signal, resolve };
      this.drain();
    });
  }

  get bufferedBytes(): number {
    return this.queuedBytes;
  }

  async *items(signal: AbortSignal): AsyncIterable<SourceItem> {
    if (this.consuming) {
      throw appError("INTERNAL", "capture source allows a single consumer");
    }
    this.consuming = true;
    const onAbort = (): void => this.drain();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        const outcome = await this.take(signal);
        if (outcome.isErr()) {
          throw outcome.error;
        }
        if (outcome.value === undefined) {
          if (signal.aborted) {
            throw appError("CANCELLED", "capture cancelled");
          }
          throw appError(
            "VALIDATION_FAILED",
            `capture ended without helper acknowledgement${this.stageSuffix()}`,
          );
        }
        yield outcome.value;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.consuming = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopSent) {
      return;
    }
    this.stopSent = true;
    this.child.kill("SIGTERM");
    if (this.shutdownTimer === undefined && !this.sawEnd) {
      this.shutdownTimer = setTimeout(() => {
        this.shutdownTimer = undefined;
        this.fail(appError("RESOURCE_RELEASE_FAILED", "audio helper did not stop"));
      }, this.shutdownTimeoutMs);
    }
  }

  dispose(): Promise<Result<void, AppError>> {
    this.disposePromise ??= this.terminate();
    return this.disposePromise;
  }

  private async terminate(): Promise<Result<void, AppError>> {
    clearTimeout(this.startupTimer);
    if (this.shutdownTimer !== undefined) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = undefined;
    }
    this.child.stdout?.resume();
    const reaped = await this.forceReap();
    await this.awaitStreamEnded(STOP_SIGNAL_WAIT_MS);
    if (this.protocolBroken !== undefined) {
      return err(this.protocolBroken);
    }
    if (reaped === "unreaped") {
      return err(appError("RESOURCE_RELEASE_FAILED", "audio helper did not terminate"));
    }
    if (reaped === "killed") {
      return err(appError("RESOURCE_RELEASE_FAILED", "audio helper required forced termination"));
    }
    const code = this.childExited;
    const signal = this.childSignal;
    if (signal !== undefined && signal !== null) {
      return err(
        appError("RESOURCE_RELEASE_FAILED", `audio helper terminated by signal ${signal}`),
      );
    }
    if (code !== undefined && code !== null && code !== 0) {
      return err(appError("RESOURCE_RELEASE_FAILED", "audio helper exited abnormally"));
    }
    return ok(undefined);
  }

  private async forceReap(): Promise<"exited" | "killed" | "unreaped"> {
    if (this.childExited !== undefined) {
      return "exited";
    }
    await this.awaitClose(EXIT_GRACE_MS);
    if (this.childExited !== undefined) {
      return "exited";
    }
    if (!this.stopSent) {
      this.stopSent = true;
      this.child.kill("SIGTERM");
    }
    await this.awaitClose(STOP_SIGNAL_WAIT_MS);
    if (this.childExited !== undefined) {
      return "exited";
    }
    this.child.kill("SIGKILL");
    await this.awaitClose(DISPOSE_TIMEOUT_MS - STOP_SIGNAL_WAIT_MS);
    return this.childExited !== undefined ? "killed" : "unreaped";
  }

  private awaitClose(timeoutMs: number): Promise<boolean> {
    if (this.childExited !== undefined) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
