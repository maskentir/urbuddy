import { appError, toAppError, type AppError } from "@kernel/errors";
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

const handshakeAckSchema = z.object({ sessionId: z.string().min(1) });

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

export interface MuseProviderOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
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

class MuseSession implements SpeechSession {
  readonly encoding = "PCM_24KHZ" as const;
  private socket: WebSocket | undefined;
  private readonly queue: SpeechProviderEvent[] = [];
  private waiter: (() => void) | undefined;
  private failure: AppError | undefined;
  private finished = false;
  private epoch = 0;
  private reconnects = 0;
  private sentBytes = 0;
  private lastProcessedMs = 0;
  private sentAtEpochStart = 0;
  private ending = false;
  private drainDeadline: ReturnType<typeof setTimeout> | undefined;
  private connectionReady: Promise<void> = Promise.resolve();
  private resolveConnection: (() => void) | undefined;
  providerSessionId: string | undefined;

  constructor(
    private readonly options: MuseProviderOptions & {
      readonly mode: "ENDPOINTING" | "DIARIZATION";
      readonly keywords: readonly string[];
      readonly signal: AbortSignal;
    },
  ) {}

  async start(): Promise<Result<void, AppError>> {
    const connected = await this.connect(0);
    return connected;
  }

  private wake(): void {
    this.waiter?.();
    this.waiter = undefined;
  }

  private push(event: SpeechProviderEvent): void {
    this.queue.push(event);
    this.wake();
  }

  private fail(error: AppError): void {
    this.failure ??= error;
    this.finished = true;
    this.wake();
  }

  private async connect(uncertainMs: number): Promise<Result<void, AppError>> {
    this.connectionReady = new Promise<void>((resolve) => {
      this.resolveConnection = resolve;
    });
    const endpoint = this.options.endpoint ?? MUSE_REALTIME_URL;
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return err(appError("VALIDATION_FAILED", "speech provider endpoint is invalid"));
    }
    if (url.protocol !== "wss:" && url.protocol !== "ws:") {
      return err(appError("VALIDATION_FAILED", "speech provider endpoint must use WebSocket TLS"));
    }
    const sessionParam = `urbuddy-${Date.now().toString(36)}-${this.epoch}`;
    url.searchParams.set("sessionId", sessionParam);
    const maxPayload = this.options.maxMessageBytes ?? 65_536;
    const socket = new WebSocket(url, { maxPayload });
    this.socket = socket;
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
          try {
            socket.terminate();
          } catch {
            reject(appError("CANCELLED", "speech connection cancelled"));
            return;
          }
          reject(appError("CANCELLED", "speech connection cancelled"));
        };
        this.options.signal.addEventListener("abort", onAbort, { once: true });
        socket.once("open", () => {
          const handshake = JSON.stringify({
            authorization: { accessToken: `Bearer ${this.options.apiKey}` },
            audioEncoding: "PCM_24KHZ",
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
          this.providerSessionId = ack.data.sessionId;
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
      this.terminateSocket(socket);
      return err(toAppError(thrown, "speech connection failed"));
    }
    this.resolveConnection?.();
    this.resolveConnection = undefined;
    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) =>
      this.onMessage(data, isBinary),
    );
    socket.on("close", (code: number) => void this.onClose(code));
    socket.on("error", () => {
      this.fail(appError("INTERNAL", "speech transport failed"));
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
      if (this.socket !== undefined) {
        this.terminateSocket(this.socket);
      }
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

  private async onClose(code: number): Promise<void> {
    if (this.drainDeadline !== undefined) {
      clearTimeout(this.drainDeadline);
      this.drainDeadline = undefined;
    }
    const kind = classifyClose(code);
    if (this.ending && kind === "normal") {
      this.finished = true;
      this.wake();
      return;
    }
    if (this.options.signal.aborted) {
      this.fail(appError("CANCELLED", "speech connection cancelled"));
      return;
    }
    if (kind === "protocol") {
      this.fail(appError("VALIDATION_FAILED", "speech provider rejected the stream configuration"));
      return;
    }
    const maxReconnects = this.options.maxReconnects ?? 2;
    if ((kind === "transient" || kind === "rateLimit") && this.reconnects < maxReconnects) {
      this.reconnects += 1;
      const backoff = this.options.reconnectBackoffMs ?? [250, 1_000];
      const delay = backoff[Math.min(this.reconnects - 1, backoff.length - 1)] ?? 1_000;
      const sleep = this.options.sleep ?? defaultSleep;
      try {
        await sleep(delay, this.options.signal);
      } catch (thrown: unknown) {
        this.fail(toAppError(thrown, "speech connection cancelled"));
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
      if (this.ending && this.socket !== undefined) {
        this.armDrainDeadline(this.socket);
        try {
          this.socket.send(JSON.stringify({ type: "endStream" }));
        } catch {
          this.fail(appError("INTERNAL", "speech end-of-input send failed"));
        }
      }
      return;
    }
    this.fail(
      appError(
        "RESOURCE_ACQUIRE_FAILED",
        kind === "rateLimit"
          ? "speech provider rate limit exhausted the reconnect budget"
          : "speech connection closed unexpectedly",
      ),
    );
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
    let socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      const deadline = Date.now() + 10_000;
      while (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        if (this.failure !== undefined) {
          return err(this.failure);
        }
        if (this.options.signal.aborted) {
          return err(appError("CANCELLED", "speech connection cancelled"));
        }
        if (Date.now() > deadline) {
          return err(appError("RESOURCE_ACQUIRE_FAILED", "speech connection is not open"));
        }
        await Promise.race([
          this.connectionReady,
          (this.options.sleep ?? defaultSleep)(10, this.options.signal),
        ]).catch((thrown: unknown) => {
          throw toAppError(thrown, "speech connection cancelled");
        });
        socket = this.socket;
      }
    }
    const maxBuffered = this.options.maxBufferedBytes ?? 262_144;
    const deadline = Date.now() + 10_000;
    while (socket.bufferedAmount + pcm.length > maxBuffered) {
      if (this.options.signal.aborted) {
        return err(appError("CANCELLED", "speech connection cancelled"));
      }
      if (Date.now() > deadline) {
        return err(appError("INTERNAL", "speech outbound buffering exceeded its bound"));
      }
      await (this.options.sleep ?? defaultSleep)(10, this.options.signal).catch(
        (thrown: unknown) => {
          throw toAppError(thrown, "speech connection cancelled");
        },
      );
      if (this.socket !== socket) {
        socket = this.socket as WebSocket;
      }
      if (socket.readyState !== WebSocket.OPEN) {
        return err(appError("RESOURCE_ACQUIRE_FAILED", "speech connection is not open"));
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        socket.send(pcm, (sendError) => {
          if (sendError !== undefined && sendError !== null) {
            reject(appError("INTERNAL", "speech audio send failed"));
          } else {
            resolve();
          }
        });
      });
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "speech audio send failed"));
    }
    this.sentBytes += pcm.length;
    return ok(undefined);
  }

  async endInput(): Promise<void> {
    let socket = this.socket;
    const deadline = Date.now() + 10_000;
    while (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      if (this.failure !== undefined || this.options.signal.aborted || Date.now() > deadline) {
        return;
      }
      await Promise.race([
        this.connectionReady,
        (this.options.sleep ?? defaultSleep)(10, this.options.signal),
      ]).catch(() => undefined);
      socket = this.socket;
    }
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

  private terminateSocket(socket: WebSocket): void {
    try {
      socket.terminate();
    } catch {
      return;
    }
  }

  async terminate(): Promise<void> {
    if (this.drainDeadline !== undefined) {
      clearTimeout(this.drainDeadline);
      this.drainDeadline = undefined;
    }
    this.finished = true;
    this.wake();
    if (this.socket !== undefined) {
      this.terminateSocket(this.socket);
    }
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
      const session = new MuseSession({
        ...options,
        mode: open.mode === "diarization" ? "DIARIZATION" : "ENDPOINTING",
        keywords: open.keywords,
        signal: open.signal,
      });
      const started = await session.start();
      if (started.isErr()) {
        return err(started.error);
      }
      return ok(session);
    },
  };
}
