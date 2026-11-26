import { createHash } from "node:crypto";

import { appError, toAppError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

import {
  streamEventSchema,
  type ReplaySummary,
  type SessionOutput,
  type StreamEvent,
} from "./events.js";

export interface ReplaySource {
  readonly events: AsyncIterable<unknown>;
  dispose(): Promise<void>;
}

export type ReplaySink = (event: SessionOutput) => void | Promise<void>;

export interface ReplayOptions {
  readonly signal?: AbortSignal;
  readonly maxUtterances?: number;
  readonly maxTextBytes?: number;
  readonly maxIdBytes?: number;
}

interface ReplayBounds {
  readonly maxUtterances: number;
  readonly maxTextBytes: number;
  readonly maxIdBytes: number;
}

const DEFAULT_MAX_UTTERANCES = 10_000;
const DEFAULT_MAX_TEXT_BYTES = 65_536;
const DEFAULT_MAX_ID_BYTES = 256;

interface TrackedUtterance {
  revision: number;
  contentHash: string;
  finalized: boolean;
}

interface ReplayCounts {
  applied: number;
  duplicates: number;
  stale: number;
  gaps: number;
  missing: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function eventHash(event: StreamEvent): string {
  return hashText(`${event.utteranceId}|${event.revision}|${event.kind}|${event.text}`);
}

function invalid(message: string): AppError {
  return appError("VALIDATION_FAILED", message);
}

export class SessionRuntime {
  async run(
    source: ReplaySource,
    sink: ReplaySink,
    options: ReplayOptions = {},
  ): Promise<Result<ReplaySummary, AppError>> {
    const bounds: ReplayBounds = {
      maxUtterances: options.maxUtterances ?? DEFAULT_MAX_UTTERANCES,
      maxTextBytes: options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES,
      maxIdBytes: options.maxIdBytes ?? DEFAULT_MAX_ID_BYTES,
    };
    if (
      !Number.isSafeInteger(bounds.maxUtterances) ||
      bounds.maxUtterances < 1 ||
      !Number.isSafeInteger(bounds.maxTextBytes) ||
      bounds.maxTextBytes < 0 ||
      !Number.isSafeInteger(bounds.maxIdBytes) ||
      bounds.maxIdBytes < 1
    ) {
      await source.dispose().catch(() => undefined);
      return err(invalid("replay resource limits are invalid"));
    }
    const outcome = await this.processStream(source, sink, options.signal, bounds);
    try {
      await source.dispose();
    } catch (thrown: unknown) {
      if (outcome.isOk()) {
        return err(toAppError(thrown, "replay cleanup failed"));
      }
    }
    return outcome;
  }

  private async processStream(
    source: ReplaySource,
    sink: ReplaySink,
    signal: AbortSignal | undefined,
    bounds: ReplayBounds,
  ): Promise<Result<ReplaySummary, AppError>> {
    if (signal !== undefined && signal.aborted) {
      return err(appError("CANCELLED", "replay cancelled before start"));
    }
    let adopted: { sessionId: string; streamId: string } | undefined;
    let expectedSeq = 0;
    let lastSeq = -1;
    let lastSeqHash = "";
    const utterances = new Map<string, TrackedUtterance>();
    const counts: ReplayCounts = {
      applied: 0,
      duplicates: 0,
      stale: 0,
      gaps: 0,
      missing: 0,
    };
    const iterator = source.events[Symbol.asyncIterator]();
    try {
      for (;;) {
        if (signal !== undefined && signal.aborted) {
          return err(appError("CANCELLED", "replay cancelled"));
        }
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        const parsed = streamEventSchema.safeParse(next.value);
        if (!parsed.success) {
          return err(
            appError("VALIDATION_FAILED", "replay event failed validation", {
              details: {
                issues: parsed.error.issues.map((issue) => issue.message).join("; "),
              },
            }),
          );
        }
        const event = parsed.data;
        if (
          byteLength(event.sessionId) > bounds.maxIdBytes ||
          byteLength(event.streamId) > bounds.maxIdBytes ||
          byteLength(event.utteranceId) > bounds.maxIdBytes
        ) {
          return err(invalid("replay event identifier exceeds the size bound"));
        }
        if (byteLength(event.text) > bounds.maxTextBytes) {
          return err(invalid("replay event text exceeds the size bound"));
        }
        if (adopted === undefined) {
          adopted = { sessionId: event.sessionId, streamId: event.streamId };
        } else if (event.sessionId !== adopted.sessionId || event.streamId !== adopted.streamId) {
          return err(invalid("replay event identity mismatch"));
        }
        if (event.seq < expectedSeq) {
          if (event.seq === lastSeq) {
            if (eventHash(event) !== lastSeqHash) {
              return err(invalid("contradictory replay event"));
            }
            counts.duplicates += 1;
            await sink({
              type: "duplicate",
              seq: event.seq,
              utteranceId: event.utteranceId,
              revision: event.revision,
            });
            continue;
          }
          counts.stale += 1;
          await sink({
            type: "stale",
            seq: event.seq,
            utteranceId: event.utteranceId,
            revision: event.revision,
            reason: "superseded",
          });
          continue;
        }
        if (event.seq > expectedSeq) {
          counts.gaps += 1;
          counts.missing += event.seq - expectedSeq;
          await sink({ type: "gap", from: expectedSeq, to: event.seq });
        }
        lastSeq = event.seq;
        lastSeqHash = eventHash(event);
        const applied = this.applyEvent(event, utterances, counts, bounds);
        if (applied.isErr()) {
          return err(applied.error);
        }
        await sink(applied.value);
        expectedSeq = event.seq + 1;
      }
      if (signal !== undefined && signal.aborted) {
        return err(appError("CANCELLED", "replay cancelled"));
      }
      if (adopted === undefined) {
        return err(invalid("replay fixture contains no events"));
      }
      const summary: ReplaySummary = {
        sessionId: adopted.sessionId,
        streamId: adopted.streamId,
        ...counts,
      };
      await sink({ type: "completed", summary });
      return ok(summary);
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "replay failed"));
    } finally {
      if (typeof iterator.return === "function") {
        await iterator.return().catch(() => undefined);
      }
    }
  }

  private applyEvent(
    event: StreamEvent,
    utterances: Map<string, TrackedUtterance>,
    counts: ReplayCounts,
    bounds: ReplayBounds,
  ): Result<SessionOutput, AppError> {
    const contentHash = hashText(event.text);
    const stored = utterances.get(event.utteranceId);
    if (stored === undefined) {
      if (utterances.size >= bounds.maxUtterances) {
        return err(invalid("session utterance capacity exceeded"));
      }
      utterances.set(event.utteranceId, {
        revision: event.revision,
        contentHash,
        finalized: event.kind === "final",
      });
      counts.applied += 1;
      return ok({
        type: "applied",
        seq: event.seq,
        utteranceId: event.utteranceId,
        revision: event.revision,
        kind: event.kind,
        text: event.text,
      });
    }
    const identical =
      event.revision === stored.revision &&
      contentHash === stored.contentHash &&
      (event.kind === "final") === stored.finalized;
    if (identical) {
      counts.duplicates += 1;
      return ok({
        type: "duplicate",
        seq: event.seq,
        utteranceId: event.utteranceId,
        revision: event.revision,
      });
    }
    if (stored.finalized) {
      counts.stale += 1;
      return ok({
        type: "stale",
        seq: event.seq,
        utteranceId: event.utteranceId,
        revision: event.revision,
        reason: "finalized",
      });
    }
    if (event.revision < stored.revision) {
      counts.stale += 1;
      return ok({
        type: "stale",
        seq: event.seq,
        utteranceId: event.utteranceId,
        revision: event.revision,
        reason: "superseded",
      });
    }
    if (event.revision === stored.revision) {
      if (contentHash !== stored.contentHash) {
        return err(invalid("contradictory replay event"));
      }
      utterances.set(event.utteranceId, {
        revision: event.revision,
        contentHash,
        finalized: true,
      });
      counts.applied += 1;
      return ok({
        type: "applied",
        seq: event.seq,
        utteranceId: event.utteranceId,
        revision: event.revision,
        kind: event.kind,
        text: event.text,
      });
    }
    utterances.set(event.utteranceId, {
      revision: event.revision,
      contentHash,
      finalized: event.kind === "final",
    });
    counts.applied += 1;
    return ok({
      type: "applied",
      seq: event.seq,
      utteranceId: event.utteranceId,
      revision: event.revision,
      kind: event.kind,
      text: event.text,
    });
  }
}
