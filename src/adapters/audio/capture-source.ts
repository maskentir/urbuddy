import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { endianness, platform } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appError, isAppError, type AppError } from "@kernel/errors";
import type {
  AudioChunk,
  AudioFormat,
  CaptureSource,
  HelperEnd,
  SourceItem,
} from "@modules/perception/audio";
import { err, ok, type Result } from "neverthrow";

const FRAME_MAGIC = 0x55424431;
const FRAME_VERSION = 1;
const HEADER_BYTES = 20;
const MAX_PAYLOAD_BYTES = 1_048_576;
const FORMAT_TAG_FLOAT32_LE = 1;

const KIND_FORMAT = 0;
const KIND_AUDIO = 1;
const KIND_END = 2;

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
  "unsupported-platform",
]);

const STARTUP_TIMEOUT_MS = 5_000;
const STOP_SIGNAL_WAIT_MS = 2_000;
const DISPOSE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFERED_BYTES = 4_194_304;
const RESUME_BYTES = 1_048_576;

function readU64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw appError("VALIDATION_FAILED", "audio frame counter exceeds safe range");
  }
  return Number(value);
}

function decodePayload(kind: number, seq: number, payload: Buffer): SourceItem {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (kind === KIND_FORMAT) {
    if (payload.byteLength !== 8) {
      throw appError("VALIDATION_FAILED", "audio format frame has an unexpected size");
    }
    const tag = view.getUint16(6, true);
    if (tag !== FORMAT_TAG_FLOAT32_LE) {
      throw appError("VALIDATION_FAILED", "audio helper reported an unsupported encoding");
    }
    const format: AudioFormat = {
      sampleRate: view.getUint32(0, true),
      channels: view.getUint16(4, true),
    };
    if (format.sampleRate === 0 || format.channels === 0 || format.channels > 8) {
      throw appError("VALIDATION_FAILED", "audio helper reported an invalid format");
    }
    return { type: "format", seq, format };
  }
  if (kind === KIND_AUDIO) {
    if (payload.byteLength < 8 || (payload.byteLength - 8) % 4 !== 0) {
      throw appError("VALIDATION_FAILED", "audio frame payload is misaligned");
    }
    const startSample = readU64(view, 0);
    const floats = new Float32Array(
      payload.buffer.slice(payload.byteOffset + 8, payload.byteOffset + payload.byteLength),
    );
    const chunk: AudioChunk = { seq, startSample, samples: floats };
    return { type: "audio", chunk };
  }
  if (kind === KIND_END) {
    if (payload.byteLength !== 26) {
      throw appError("VALIDATION_FAILED", "audio end frame has an unexpected size");
    }
    const reason = view.getUint16(24, true);
    if (reason !== 0 && reason !== 1) {
      throw appError("VALIDATION_FAILED", "audio helper reported an unknown end reason");
    }
    const end: HelperEnd = {
      captured: readU64(view, 0),
      delivered: readU64(view, 8),
      dropped: readU64(view, 16),
      reason: reason === 1 ? "cancelled" : "completed",
    };
    return { type: "end", seq, end };
  }
  throw appError("VALIDATION_FAILED", "audio helper sent an unknown frame kind");
}

export class FrameDecoder {
  private pending = Buffer.alloc(0);

  push(data: Buffer): SourceItem[] {
    this.pending = Buffer.concat([this.pending, data]);
    const items: SourceItem[] = [];
    while (this.pending.byteLength >= HEADER_BYTES) {
      const view = new DataView(this.pending.buffer, this.pending.byteOffset, HEADER_BYTES);
      if (view.getUint32(0, true) !== FRAME_MAGIC) {
        throw appError("VALIDATION_FAILED", "unrecognized audio frame");
      }
      if (
        view.getUint16(4, true) !== KIND_FORMAT &&
        view.getUint16(4, true) !== KIND_AUDIO &&
        view.getUint16(4, true) !== KIND_END
      ) {
        throw appError("VALIDATION_FAILED", "audio helper sent an unknown frame kind");
      }
      const kind = view.getUint16(4, true);
      if (kind !== KIND_FORMAT && kind !== KIND_AUDIO && kind !== KIND_END) {
        throw appError("VALIDATION_FAILED", "audio helper sent an unknown frame kind");
      }
      if (view.getUint16(6, true) !== FRAME_VERSION) {
        throw appError("VALIDATION_FAILED", "unsupported audio protocol version");
      }
      const seq = readU64(view, 8);
      const payloadLen = view.getUint32(16, true);
      if (payloadLen > MAX_PAYLOAD_BYTES) {
        throw appError("VALIDATION_FAILED", "audio frame exceeds its size bound");
      }
      if (this.pending.byteLength < HEADER_BYTES + payloadLen) {
        return items;
      }
      const payload = this.pending.subarray(HEADER_BYTES, HEADER_BYTES + payloadLen);
      items.push(decodePayload(kind, seq, payload));
      this.pending = this.pending.subarray(HEADER_BYTES + payloadLen);
    }
    return items;
  }
}

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
  const args = ["--chunk-frames", "2048"];
  if (synthetic > 0) {
    args.push("--synthetic-frames", String(synthetic));
  }
  const validated = checkExecutable(input.helperPath);
  if (validated.isErr()) {
    return err(validated.error);
  }
  try {
    const child = spawn(input.helperPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    return ok(new ChildCaptureSource(child, maxBuffered));
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
  private streamEnded = false;
  private childExited: number | null | undefined;
  private stage: string | undefined;
  private stderrTail = "";
  private paused = false;
  private consuming = false;
  private ready = false;
  private stopSent = false;
  private disposePromise: Promise<Result<void, AppError>> | undefined;
  private readonly startupTimer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly child: ChildProcess,
    private readonly maxBuffered: number,
  ) {
    this.startupTimer = setTimeout(() => {
      if (!this.ready) {
        this.fail(appError("RESOURCE_ACQUIRE_FAILED", "audio helper did not become ready"));
      }
    }, STARTUP_TIMEOUT_MS);
    child.stdout?.on("data", (data: Buffer) => this.onData(data));
    child.stdout?.on("end", () => this.onStreamEnd());
    child.stdout?.on("error", () => this.onStreamEnd());
    child.stderr?.on("data", (data: Buffer) => this.onStderr(data));
    child.on("error", () => {
      this.fail(appError("RESOURCE_ACQUIRE_FAILED", "audio helper failed to start"));
    });
    child.on("close", (code) => {
      this.childExited = code;
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
      } else if (code !== 0 && code !== null) {
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

  private onStderr(data: Buffer): void {
    const text = data.toString("utf8");
    this.stderrTail = `${this.stderrTail}${text}`.slice(-2048);
    for (const line of text.split("\n")) {
      const stage = parseStageLine(line);
      if (stage !== undefined) {
        this.stage = stage;
      }
    }
  }

  private onData(data: Buffer): void {
    try {
      for (const item of this.decoder.push(data)) {
        this.markReady();
        if (item.type === "audio") {
          this.queuedBytes += item.chunk.samples.byteLength;
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
    this.drain();
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
          throw appError("VALIDATION_FAILED", "capture ended without helper acknowledgement");
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
  }

  dispose(): Promise<Result<void, AppError>> {
    this.disposePromise ??= this.terminate();
    return this.disposePromise;
  }

  private async terminate(): Promise<Result<void, AppError>> {
    clearTimeout(this.startupTimer);
    this.child.stdout?.resume();
    if (this.childExited === undefined) {
      if (!this.stopSent) {
        this.stopSent = true;
        this.child.kill("SIGTERM");
      }
      const closed = await this.awaitClose(STOP_SIGNAL_WAIT_MS);
      if (!closed) {
        this.child.kill("SIGKILL");
        const killed = await this.awaitClose(DISPOSE_TIMEOUT_MS - STOP_SIGNAL_WAIT_MS);
        if (!killed) {
          return err(appError("RESOURCE_RELEASE_FAILED", "audio helper did not terminate"));
        }
      }
    }
    return ok(undefined);
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
