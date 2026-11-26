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
const RESEND_FRAME_BYTES = 3_840;
const RESEND_FRAME_MS = 80;

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

export interface MuseProviderOptions {
  readonly apiKey: string;
  readonly testLoopbackEndpoint?: string;
  readonly handshakeTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxMessageBytes?: number;
  readonly maxReconnects?: number;
  readonly reconnectBackoffMs?: readonly number[];
  readonly maxResendBytes?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface SentChunk {
  readonly startOffset: number;
  readonly pcm: Buffer;
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
  private sentLog: SentChunk[] = [];
  private sentLogBytes = 0;
  private ending = false;
  private drainDeadline: ReturnType<typeof setTimeout> | undefined;
  private readonly shutdown: AbortController;
  private settled: Promise<void>;
  private resolveSettled: (() => void) | undefined;

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
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
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

  private fail(error: AppError): void {
    this.failure ??= error;
    this.finished = true;
    this.resolveSettled?.();
    this.wake();
  }

  private settleShutdown(): void {
    this.terminated = true;
    this.shutdown.abort();
    this.finished = true;
    this.resolveSettled?.();
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
    this.epochGate = new Promise<void>((resolve) => {
      this.resolveEpoch = resolve;
    });
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
    const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? 10_000;
    try {
      await new Promise<void>((resolve, reject) => {
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
          socket.send(handshake);
        });
        socket.once("message", (data: WebSocket.RawData, isBinary: boolean) => {
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
    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (this.isCurrent(socket)) {
        this.onMessage(data, isBinary);
      }
    });
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
    this.push({ type: "connectionEpoch", epoch: this.epoch, uncertainMs });
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
        this.push({ type: "turnStarted", turnRef: String(value.turnId) });
        break;
      case "speechEnd":
        this.push({ type: "turnEnded", turnRef: String(value.turnId) });
        break;
      case "speechComplete":
        this.push({
          type: "completed",
          turnRef: String(value.turnId),
          text: value.transcript,
          audioProcessedMs: value.audioProcessedMs,
        });
        break;
      case "transcript":
        this.lastProcessedMs = Math.max(this.lastProcessedMs, value.audioProcessedMs);
        if (!value.final) {
          this.push({
            type: "partial",
            text: value.transcript,
            audioProcessedMs: value.audioProcessedMs,
          });
        }
        break;
      case "speaker":
        this.push({
          type: "speaker",
          label: value.label,
          audioProcessedMs: value.audioProcessedMs,
        });
        break;
      case "audioProgress":
        this.lastProcessedMs = Math.max(this.lastProcessedMs, value.audioProcessedMs);
        this.push({ type: "progress", audioProcessedMs: value.audioProcessedMs });
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
    if (this.ending && kind === "normal") {
      this.finished = true;
      this.wake();
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
    const processedBytes = Math.floor((this.lastProcessedMs / 1000) * 48_000);
    const resendable = this.resendableFrom(processedBytes);
    if (resendable.isErr()) {
      this.fail(resendable.error);
      return;
    }
    this.reconnects += 1;
    const backoff = this.options.reconnectBackoffMs ?? [250, 1_000];
    const delay = backoff[Math.min(this.reconnects - 1, backoff.length - 1)] ?? 1_000;
    const sleep = this.options.sleep ?? defaultSleep;
    const combined = AbortSignal.any([this.options.signal, this.shutdown.signal]);
    try {
      await sleep(delay, combined);
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
    const sentThisEpoch = this.sentBytes - this.sentAtEpochStart;
    const sentMs = Math.round((sentThisEpoch / 48_000) * 1000);
    const uncertainMs = Math.max(0, sentMs - this.lastProcessedMs);
    this.epoch += 1;
    this.lastProcessedMs = 0;
    const reconnected = await this.connect(uncertainMs);
    if (reconnected.isErr()) {
      this.fail(reconnected.error);
      return;
    }
    if (resendable.value.length > 0) {
      const resent = await this.resendPaced(resendable.value);
      if (resent.isErr()) {
        this.fail(resent.error);
        return;
      }
    }
    if (this.ending && this.active !== undefined) {
      this.armDrainDeadline(this.active);
      try {
        this.active.send(JSON.stringify({ type: "endStream" }));
      } catch {
        this.fail(appError("INTERNAL", "speech end-of-input send failed"));
      }
    }
  }

  private resendableFrom(processedBytes: number): Result<readonly Buffer[], AppError> {
    const needed: Buffer[] = [];
    for (const chunk of this.sentLog) {
      if (chunk.startOffset + chunk.pcm.length <= processedBytes) {
        continue;
      }
      if (chunk.startOffset > processedBytes && needed.length === 0) {
        return err(
          appError(
            "RESOURCE_ACQUIRE_FAILED",
            "speech resend buffer no longer covers unprocessed audio",
          ),
        );
      }
      needed.push(chunk.pcm);
    }
    if (needed.length === 0 && processedBytes < this.sentBytes) {
      return err(
        appError(
          "RESOURCE_ACQUIRE_FAILED",
          "speech resend buffer no longer covers unprocessed audio",
        ),
      );
    }
    return ok(needed);
  }

  private async resendPaced(chunks: readonly Buffer[]): Promise<Result<void, AppError>> {
    const sleep = this.options.sleep ?? defaultSleep;
    const combined = AbortSignal.any([this.options.signal, this.shutdown.signal]);
    const frames: Buffer[] = [];
    for (const chunk of chunks) {
      for (let offset = 0; offset < chunk.length; offset += RESEND_FRAME_BYTES) {
        frames.push(chunk.subarray(offset, offset + RESEND_FRAME_BYTES));
      }
    }
    for (let index = 0; index < frames.length; index += 1) {
      const socket = this.active;
      if (
        socket === undefined ||
        socket.readyState !== WebSocket.OPEN ||
        this.failure !== undefined ||
        this.terminated
      ) {
        return err(appError("RESOURCE_ACQUIRE_FAILED", "speech connection changed during resend"));
      }
      const sent = await this.sendChunk(socket, frames[index] as Buffer);
      if (sent.isErr()) {
        return err(sent.error);
      }
      if (index + 1 < frames.length) {
        try {
          await sleep(RESEND_FRAME_MS, combined);
        } catch (thrown: unknown) {
          return err(toAppError(thrown, "speech connection cancelled"));
        }
      }
    }
    return ok(undefined);
  }

  private recordSent(pcm: Buffer): void {
    const cap = this.options.maxResendBytes ?? 4_194_304;
    this.sentLog.push({ startOffset: this.sentBytes, pcm });
    this.sentLogBytes += pcm.length;
    this.sentBytes += pcm.length;
    while (this.sentLogBytes > cap && this.sentLog.length > 0) {
      const evicted = this.sentLog.shift();
      if (evicted !== undefined) {
        this.sentLogBytes -= evicted.pcm.length;
      }
    }
  }

  private async sendChunk(socket: WebSocket, pcm: Buffer): Promise<Result<void, AppError>> {
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
        this.settled.then(() => {
          throw appError("CANCELLED", "speech connection cancelled");
        }),
      ]);
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "speech audio send failed"));
    }
    return ok(undefined);
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
      if (Date.now() > deadline) {
        return err(appError("RESOURCE_ACQUIRE_FAILED", "speech connection is not open"));
      }
      const gate = this.epochGate;
      await Promise.race([gate, this.settled]).catch(() => undefined);
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
      await Promise.race([
        sleep(10, AbortSignal.any([this.options.signal, this.shutdown.signal])),
        this.settled,
      ]).catch(() => undefined);
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
    this.recordSent(pcm);
    return ok(undefined);
  }

  async endInput(): Promise<void> {
    const ready = await this.waitForActive();
    if (ready.isErr()) {
      return;
    }
    const socket = ready.value;
    this.ending = true;
    this.armDrainDeadline(socket);
    try {
      socket.send(JSON.stringify({ type: "endStream" }));
    } catch {
      this.fail(appError("INTERNAL", "speech end-of-input send failed"));
    }
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

  async terminate(): Promise<void> {
    if (this.drainDeadline !== undefined) {
      clearTimeout(this.drainDeadline);
      this.drainDeadline = undefined;
    }
    const active = this.active;
    const pending = this.pending;
    this.active = undefined;
    this.pending = undefined;
    this.settleShutdown();
    this.terminateSocket(active);
    this.terminateSocket(pending);
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
