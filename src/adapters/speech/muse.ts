import { appError, toAppError, type AppError } from "@kernel/errors";
import type { PcmEncoding } from "@modules/perception/convert";
import type {
  OpenSpeechSessionOptions,
  SpeechProvider,
  SpeechProviderEvent,
  SpeechSession,
} from "@modules/perception/speech";
import { err, ok, type Result } from "neverthrow";
import WebSocket from "ws";
import { z } from "zod";

const MUSE_MODEL_ID = "muse-voice-transcribe-1.0";
const MUSE_REALTIME_URL = "wss://api.meta.ai/v1/asr/realtime";

const handshakeAckSchema = z.object({ sessionId: z.string().min(1) }).strict();

const serverEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("speechStart"),
    turnId: z.number().int(),
    audioProcessedMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("speechEnd"),
    turnId: z.number().int(),
    audioProcessedMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("speechComplete"),
    turnId: z.number().int(),
    transcript: z.string(),
    audioProcessedMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("transcript"),
    transcript: z.string(),
    final: z.boolean(),
    audioProcessedMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("speaker"),
    label: z.string().min(1),
    audioProcessedMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("audioProgress"),
    audioProcessedMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    sessionId: z.string(),
    errorCode: z.string().optional(),
    errorType: z.string().optional(),
  }),
]);

const MAX_QUEUE_EVENTS = 1_024;
const SEND_WAIT_MS = 10_000;
const SEND_CALLBACK_TIMEOUT_MS = 5_000;
const TERMINATE_CLOSE_MS = 2_000;

function bytesPerSecond(encoding: PcmEncoding): number {
  return encoding === "PCM_16KHZ" ? 32_000 : 48_000;
}

function validateEndpoint(raw: string): Result<URL, AppError> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err(appError("VALIDATION_FAILED", "speech provider endpoint is invalid"));
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol === "wss:" && url.host === "api.meta.ai") {
    return ok(url);
  }
  if (loopback && (url.protocol === "ws:" || url.protocol === "wss:")) {
    return ok(url);
  }
  return err(
    appError("VALIDATION_FAILED", "speech provider endpoint is not an authorized destination"),
  );
}

function classifyClose(code: number): "normal" | "protocol" | "transient" | "rateLimit" {
  if (code === 1000) {
    return "normal";
  }
  if (code === 1008) {
    return "protocol";
  }
  if (code === 1013) {
    return "rateLimit";
  }
  return "transient";
}

export const MUSE_TRANSCRIBE_ENDPOINT_ENV = "URBUDDY_TRANSCRIBE_ENDPOINT";

export function resolveMuseEndpoint(raw: string | undefined): Result<string, AppError> {
  if (raw === undefined || raw.trim() === "") {
    return ok(MUSE_REALTIME_URL);
  }
  const validated = validateEndpoint(raw.trim());
  if (validated.isErr()) {
    return err(validated.error);
  }
  return ok(validated.value.toString());
}

export function isLoopbackEndpoint(raw: string | undefined): boolean {
  const resolved = resolveMuseEndpoint(raw);
  if (resolved.isErr()) {
    return false;
  }
  try {
    return new URL(resolved.value).hostname !== "api.meta.ai";
  } catch {
    return false;
  }
}

export interface MuseProviderOptions {
  readonly apiKey: string;
  readonly testLoopbackEndpoint?: string;
  readonly handshakeTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxMessageBytes?: number;
  readonly maxReconnects?: number;
  readonly reconnectBackoffMs?: readonly number[];
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(appError("CANCELLED", "speech connection cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(appError("CANCELLED", "speech connection cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class MuseSession implements SpeechSession {
  readonly encoding: PcmEncoding;
  readonly providerSessionId: string | undefined = undefined;
  private active: WebSocket | undefined;
  private pending: WebSocket | undefined;
  private epochAnnounced = false;
  private readonly staged: SpeechProviderEvent[] = [];
  private connectionId = 0;
  private epochGate: Promise<void> = Promise.resolve();
  private resolveEpoch: (() => void) | undefined;
  private terminated = false;
  private readonly queue: SpeechProviderEvent[] = [];
  private waiter: (() => void) | undefined;
  private failure: AppError | undefined;
  private finished = false;
  private epoch = 0;
  private reconnects = 0;
  private sentBytes = 0;
  private lastProcessedMs = 0;
  private sentAtEpochStart = 0;
  private readonly closeObserved = new Map<WebSocket, Promise<void>>();
  private ending = false;
  private drainDeadline: ReturnType<typeof setTimeout> | undefined;
  private readonly shutdown: AbortController;
  private readonly combined: AbortSignal;

  constructor(
    private readonly options: MuseProviderOptions & {
      readonly mode: "ENDPOINTING" | "DIARIZATION";
      readonly keywords: readonly string[];
      readonly signal: AbortSignal;
    },
    encoding: PcmEncoding,
  ) {
    this.encoding = encoding;
    this.shutdown = new AbortController();
    this.combined = AbortSignal.any([this.options.signal, this.shutdown.signal]);
  }

  async start(): Promise<Result<void, AppError>> {
    const connected = await this.connect(0);
    return connected;
  }

  private wake(): void {
    this.waiter?.();
    this.waiter = undefined;
  }

  private push(event: SpeechProviderEvent): void {
    if (this.queue.length >= MAX_QUEUE_EVENTS) {
      this.fail(appError("INTERNAL", "speech event queue exceeded its bound"));
      return;
    }
    this.queue.push(event);
    this.wake();
  }

  private emit(event: SpeechProviderEvent): void {
    if (this.epochAnnounced) {
      this.push(event);
      return;
    }
    if (this.staged.length >= MAX_QUEUE_EVENTS) {
      this.fail(appError("INTERNAL", "speech event queue exceeded its bound"));
      return;
    }
    this.staged.push(event);
  }

  private announceEpoch(uncertainMs: number): void {
    this.push({ type: "connectionEpoch", epoch: this.epoch, uncertainMs });
    this.epochAnnounced = true;
    for (const staged of this.staged.splice(0, this.staged.length)) {
      this.push(staged);
    }
  }

  private fail(error: AppError): void {
    this.failure ??= error;
    this.terminated = true;
    this.shutdown.abort();
    this.finished = true;
    this.wake();
  }

  private renewGate(): void {
    this.resolveEpoch?.();
    this.resolveEpoch = undefined;
    this.epochGate = new Promise<void>((resolve) => {
      this.resolveEpoch = resolve;
    });
  }

  private rejectedAfter(ms: number, signal: AbortSignal): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        reject(appError("RESOURCE_ACQUIRE_FAILED", "speech connection is not open"));
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(appError("CANCELLED", "speech connection cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private watchClose(socket: WebSocket): Promise<void> {
    const observed = new Promise<void>((resolve) => {
      socket.once("close", () => {
        resolve();
      });
    });
    this.closeObserved.set(socket, observed);
    return observed;
  }

  private settleShutdown(): void {
    this.terminated = true;
    this.shutdown.abort();
    this.finished = true;
    this.wake();
  }

  private terminateSocket(socket: WebSocket | undefined): void {
    if (socket === undefined) {
      return;
    }
    try {
      socket.terminate();
    } catch {
      return;
    }
  }

  private isCurrent(socket: WebSocket): boolean {
    return socket === this.active || socket === this.pending;
  }

  private async connect(uncertainMs: number): Promise<Result<void, AppError>> {
    if (this.terminated || this.options.signal.aborted) {
      return err(appError("CANCELLED", "speech connection cancelled"));
    }
    this.epochAnnounced = false;
    this.renewGate();
    const endpoint = this.options.testLoopbackEndpoint ?? MUSE_REALTIME_URL;
    const validated = validateEndpoint(endpoint);
    if (validated.isErr()) {
      return err(validated.error);
    }
    const url = validated.value;
    const sessionParam = `urbuddy-${Date.now().toString(36)}-${this.epoch}`;
    url.searchParams.set("sessionId", sessionParam);
    const maxPayload = this.options.maxMessageBytes ?? 65_536;
    const socket = new WebSocket(url, { maxPayload });
    this.connectionId += 1;
    const attempt = this.connectionId;
    this.pending = socket;
    socket.binaryType = "nodebuffer";
    this.watchClose(socket);
    const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? 10_000;
    let handshakeDone = false;
    const routeMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (!this.isCurrent(socket)) {
        return;
      }
      if (handshakeDone) {
        this.onMessage(data, isBinary);
        return;
      }
      handshakeDone = true;
      settleHandshakeMessage(data, isBinary);
    };
    let settleHandshakeMessage: (data: WebSocket.RawData, isBinary: boolean) => void = () =>
      undefined;
    socket.on("message", routeMessage);
    try {
      await new Promise<void>((resolve, reject) => {
        settleHandshakeMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
          cleanup();
          if (isBinary) {
            reject(appError("VALIDATION_FAILED", "speech handshake reply was not text"));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data.toString());
          } catch {
            reject(appError("VALIDATION_FAILED", "speech handshake reply was malformed"));
            return;
          }
          const ack = handshakeAckSchema.safeParse(parsed);
          if (!ack.success) {
            reject(appError("VALIDATION_FAILED", "speech handshake was rejected"));
            return;
          }
          (this as { providerSessionId: string | undefined }).providerSessionId =
            ack.data.sessionId;
          this.sentAtEpochStart = this.sentBytes;
          resolve();
        };
        const timer = setTimeout(() => {
          reject(appError("RESOURCE_ACQUIRE_FAILED", "speech handshake timed out"));
        }, handshakeTimeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          this.options.signal.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
          cleanup();
          reject(appError("CANCELLED", "speech connection cancelled"));
        };
        this.options.signal.addEventListener("abort", onAbort, { once: true });
        socket.once("open", () => {
          if (this.terminated || this.options.signal.aborted) {
            cleanup();
            reject(appError("CANCELLED", "speech connection cancelled"));
            return;
          }
          const handshake = JSON.stringify({
            authorization: { accessToken: `Bearer ${this.options.apiKey}` },
            audioEncoding: this.encoding,
            model: MUSE_MODEL_ID,
            mode: this.options.mode,
            partialMode: "CUMULATIVE",
            emitAudioProgress: true,
            ...(this.options.keywords.length === 0 ? {} : { keywords: [...this.options.keywords] }),
            languageBias: ["English"],
          });
          try {
            socket.send(handshake);
          } catch {
            cleanup();
            reject(appError("RESOURCE_ACQUIRE_FAILED", "speech connection failed"));
          }
        });
        socket.once("error", () => {
          cleanup();
          reject(appError("RESOURCE_ACQUIRE_FAILED", "speech connection failed"));
        });
        socket.once("close", (code: number) => {
          cleanup();
          reject(
            code === 1008
              ? appError("VALIDATION_FAILED", "speech provider rejected the stream configuration")
              : appError("RESOURCE_ACQUIRE_FAILED", "speech connection closed during handshake"),
          );
        });
      });
    } catch (thrown: unknown) {
      if (this.pending === socket) {
        this.pending = undefined;
      }
      this.terminateSocket(socket);
      return err(toAppError(thrown, "speech connection failed"));
    }
    if (attempt !== this.connectionId || this.terminated) {
      if (this.pending === socket) {
        this.pending = undefined;
      }
      this.terminateSocket(socket);
      return err(appError("CANCELLED", "speech connection cancelled"));
    }
    if (this.pending === socket) {
      this.pending = undefined;
    }
    this.active = socket;
    this.resolveEpoch?.();
    this.resolveEpoch = undefined;
    socket.on("close", (code: number) => {
      if (socket === this.active) {
        this.active = undefined;
        void this.onClose(socket, code);
      }
    });
    socket.on("error", () => {
      if (this.isCurrent(socket)) {
        this.fail(appError("INTERNAL", "speech transport failed"));
      }
    });
    this.announceEpoch(uncertainMs);
    return ok(undefined);
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.fail(appError("VALIDATION_FAILED", "speech provider sent a binary event frame"));
      return;
    }
    const text = data.toString();
    if (Buffer.byteLength(text, "utf8") > (this.options.maxMessageBytes ?? 65_536)) {
      this.fail(appError("VALIDATION_FAILED", "speech provider message exceeds the size bound"));
      this.terminateSocket(this.active);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.fail(appError("VALIDATION_FAILED", "speech provider message was malformed"));
      return;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === "string" &&
      ![
        "speechStart",
        "speechEnd",
        "speechComplete",
        "transcript",
        "speaker",
        "audioProgress",
        "error",
      ].includes((parsed as { type: string }).type)
    ) {
      return;
    }
    const event = serverEventSchema.safeParse(parsed);
    if (!event.success) {
      this.fail(appError("VALIDATION_FAILED", "speech provider event failed validation"));
      return;
    }
    const value = event.data;
    switch (value.type) {
      case "speechStart":
        this.emit({ type: "turnStarted", turnRef: String(value.turnId) });
        break;
      case "speechEnd":
        this.emit({ type: "turnEnded", turnRef: String(value.turnId) });
        break;
      case "speechComplete":
        this.emit({
          type: "completed",
          turnRef: String(value.turnId),
          text: value.transcript,
          audioProcessedMs: value.audioProcessedMs,
        });
        break;
      case "transcript":
        this.lastProcessedMs = Math.max(this.lastProcessedMs, value.audioProcessedMs);
        if (!value.final) {
          this.emit({
            type: "partial",
            text: value.transcript,
            audioProcessedMs: value.audioProcessedMs,
          });
        }
        break;
      case "speaker":
        this.emit({
          type: "speaker",
          label: value.label,
          audioProcessedMs: value.audioProcessedMs,
        });
        break;
      case "audioProgress":
        this.lastProcessedMs = Math.max(this.lastProcessedMs, value.audioProcessedMs);
        this.emit({ type: "progress", audioProcessedMs: value.audioProcessedMs });
        break;
      case "error":
        this.fail(
          appError("INTERNAL", "speech provider reported a fatal error", {
            details: {
              provider: "muse",
              ...(value.errorCode === undefined ? {} : { providerCode: value.errorCode }),
            },
          }),
        );
        break;
    }
  }

  private async onClose(_socket: WebSocket, code: number): Promise<void> {
    this.renewGate();
    if (this.drainDeadline !== undefined) {
      clearTimeout(this.drainDeadline);
      this.drainDeadline = undefined;
    }
    const kind = classifyClose(code);
    if (this.terminated || this.options.signal.aborted) {
      this.finished = true;
      this.wake();
      return;
    }
    if (this.ending) {
      if (kind === "normal") {
        this.finished = true;
        this.wake();
        return;
      }
      this.fail(
        appError("RESOURCE_ACQUIRE_FAILED", "speech connection closed before results drained"),
      );
      return;
    }
    if (kind === "normal") {
      this.fail(appError("RESOURCE_ACQUIRE_FAILED", "speech connection closed unexpectedly"));
      return;
    }
    if (kind === "protocol") {
      this.fail(appError("VALIDATION_FAILED", "speech provider rejected the stream configuration"));
      return;
    }
    const maxReconnects = this.options.maxReconnects ?? 2;
    if (kind !== "transient" && kind !== "rateLimit") {
      this.fail(appError("RESOURCE_ACQUIRE_FAILED", "speech connection closed unexpectedly"));
      return;
    }
    if (this.reconnects >= maxReconnects) {
      this.fail(
        appError(
          "RESOURCE_ACQUIRE_FAILED",
          kind === "rateLimit"
            ? "speech provider rate limit exhausted the reconnect budget"
            : "speech connection closed unexpectedly",
        ),
      );
      return;
    }
    this.reconnects += 1;
    const backoff = this.options.reconnectBackoffMs ?? [250, 1_000];
    const delay = backoff[Math.min(this.reconnects - 1, backoff.length - 1)] ?? 1_000;
    const sleep = this.options.sleep ?? defaultSleep;
    try {
      await sleep(delay, this.combined);
    } catch (thrown: unknown) {
      this.fail(toAppError(thrown, "speech connection cancelled"));
      return;
    }
    if (this.terminated || this.options.signal.aborted) {
      this.fail(
        toAppError(
          appError("CANCELLED", "speech connection cancelled"),
          "speech connection cancelled",
        ),
      );
      return;
    }
    if (this.ending) {
      this.fail(
        appError("RESOURCE_ACQUIRE_FAILED", "speech connection closed before results drained"),
      );
      return;
    }
    const sentThisEpoch = this.sentBytes - this.sentAtEpochStart;
    const sentMs = Math.round((sentThisEpoch / bytesPerSecond(this.encoding)) * 1000);
    const uncertainMs = Math.max(0, sentMs - this.lastProcessedMs);
    this.epoch += 1;
    this.lastProcessedMs = 0;
    const reconnected = await this.connect(uncertainMs);
    if (reconnected.isErr()) {
      this.fail(reconnected.error);
    }
  }

  private async sendChunk(socket: WebSocket, pcm: Buffer): Promise<Result<void, AppError>> {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.fail(appError("INTERNAL", "speech audio send timed out"));
      this.terminateSocket(socket);
    }, SEND_CALLBACK_TIMEOUT_MS);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (this.combined.aborted) {
        reject(appError("CANCELLED", "speech connection cancelled"));
        return;
      }
      onAbort = (): void => {
        reject(appError("CANCELLED", "speech connection cancelled"));
      };
      this.combined.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          socket.send(pcm, (sendError) => {
            if (sendError !== undefined && sendError !== null) {
              reject(appError("INTERNAL", "speech audio send failed"));
            } else {
              resolve();
            }
          });
        }),
        aborted,
      ]);
      if (timedOut) {
        return err(appError("INTERNAL", "speech audio send timed out"));
      }
      return ok(undefined);
    } catch (thrown: unknown) {
      if (timedOut) {
        return err(appError("INTERNAL", "speech audio send timed out"));
      }
      return err(toAppError(thrown, "speech audio send failed"));
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) {
        this.combined.removeEventListener("abort", onAbort);
      }
    }
  }

  private async waitForActive(): Promise<Result<WebSocket, AppError>> {
    const deadline = Date.now() + SEND_WAIT_MS;
    for (;;) {
      if (this.failure !== undefined) {
        return err(this.failure);
      }
      if (this.terminated || this.options.signal.aborted) {
        return err(appError("CANCELLED", "speech connection cancelled"));
      }
      const socket = this.active;
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
        return ok(socket);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return err(appError("RESOURCE_ACQUIRE_FAILED", "speech connection is not open"));
      }
      await Promise.race([this.epochGate, this.rejectedAfter(remaining, this.combined)]).catch(
        () => undefined,
      );
    }
  }

  async *events(): AsyncIterable<SpeechProviderEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.failure !== undefined) {
        throw this.failure;
      }
      if (this.finished) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  async sendAudio(pcm: Buffer): Promise<Result<void, AppError>> {
    if (this.failure !== undefined) {
      return err(this.failure);
    }
    if (this.terminated || this.options.signal.aborted) {
      return err(appError("CANCELLED", "speech connection cancelled"));
    }
    const ready = await this.waitForActive();
    if (ready.isErr()) {
      return err(ready.error);
    }
    let socket = ready.value;
    const maxBuffered = this.options.maxBufferedBytes ?? 262_144;
    const deadline = Date.now() + SEND_WAIT_MS;
    while (socket.bufferedAmount + pcm.length > maxBuffered) {
      if (this.failure !== undefined) {
        return err(this.failure);
      }
      if (this.terminated || this.options.signal.aborted) {
        return err(appError("CANCELLED", "speech connection cancelled"));
      }
      if (Date.now() > deadline) {
        return err(appError("INTERNAL", "speech outbound buffering exceeded its bound"));
      }
      const sleep = this.options.sleep ?? defaultSleep;
      await sleep(10, this.combined).catch(() => undefined);
      const current = await this.waitForActive();
      if (current.isErr()) {
        return err(current.error);
      }
      socket = current.value;
    }
    const sent = await this.sendChunk(socket, pcm);
    if (sent.isErr()) {
      return err(sent.error);
    }
    this.sentBytes += pcm.length;
    return ok(undefined);
  }

  async endInput(): Promise<Result<void, AppError>> {
    this.ending = true;
    const ready = await this.waitForActive();
    if (ready.isErr()) {
      return err(ready.error);
    }
    const socket = ready.value;
    this.armDrainDeadline(socket);
    try {
      socket.send(JSON.stringify({ type: "endStream" }));
    } catch {
      const failure = appError("INTERNAL", "speech end-of-input send failed");
      this.fail(failure);
      return err(failure);
    }
    return ok(undefined);
  }

  private armDrainDeadline(socket: WebSocket): void {
    if (this.drainDeadline !== undefined) {
      clearTimeout(this.drainDeadline);
    }
    const drainTimeoutMs = this.options.drainTimeoutMs ?? 15_000;
    this.drainDeadline = setTimeout(() => {
      this.fail(appError("INTERNAL", "speech provider did not drain results within its bound"));
      this.terminateSocket(socket);
    }, drainTimeoutMs);
  }

  async terminate(): Promise<Result<void, AppError>> {
    if (this.drainDeadline !== undefined) {
      clearTimeout(this.drainDeadline);
      this.drainDeadline = undefined;
    }
    const active = this.active;
    const pending = this.pending;
    const sockets: WebSocket[] = [];
    if (active !== undefined) {
      sockets.push(active);
    }
    if (pending !== undefined && pending !== active) {
      sockets.push(pending);
    }
    this.active = undefined;
    this.pending = undefined;
    this.settleShutdown();
    for (const socket of sockets) {
      try {
        if (this.failure === undefined && socket.readyState === WebSocket.OPEN) {
          socket.close(1000);
        } else {
          this.terminateSocket(socket);
        }
      } catch {
        this.terminateSocket(socket);
      }
    }
    if (sockets.length === 0) {
      return ok(undefined);
    }
    const observed = sockets.map((socket) => this.closeObserved.get(socket) ?? Promise.resolve());
    let expired = false;
    const bound = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        expired = true;
        resolve();
      }, TERMINATE_CLOSE_MS);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });
    await Promise.race([Promise.all(observed).then(() => undefined), bound]);
    if (expired) {
      for (const socket of sockets) {
        this.terminateSocket(socket);
      }
      return err(appError("RESOURCE_RELEASE_FAILED", "speech transport closure unobserved"));
    }
    return ok(undefined);
  }
}

export function createMuseProvider(options: MuseProviderOptions): SpeechProvider {
  return {
    providerId: "muse",
    modelId: MUSE_MODEL_ID,
    async openSession(open: OpenSpeechSessionOptions): Promise<Result<SpeechSession, AppError>> {
      if (options.apiKey.trim().length === 0) {
        return err(appError("CONFIG_INVALID", "speech provider credential is not configured"));
      }
      if (open.encoding !== "PCM_24KHZ" && open.encoding !== "PCM_16KHZ") {
        return err(appError("VALIDATION_FAILED", "speech session encoding is unsupported"));
      }
      const session = new MuseSession(
        {
          ...options,
          mode: open.mode === "diarization" ? "DIARIZATION" : "ENDPOINTING",
          keywords: open.keywords,
          signal: open.signal,
        },
        open.encoding,
      );
      const started = await session.start();
      if (started.isErr()) {
        return err(started.error);
      }
      return ok(session);
    },
  };
}
