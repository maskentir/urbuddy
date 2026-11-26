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
}

const DEFAULT_MAX_UTTERANCES = 10_000;

interface TrackedUtterance {
  revision: number;
  text: string;
  finalized: boolean;
}

export class SessionRuntime {
  async run(
    source: ReplaySource,
    sink: ReplaySink,
    options: ReplayOptions = {},
  ): Promise<Result<ReplaySummary, AppError>> {
    const maxUtterances = options.maxUtterances ?? DEFAULT_MAX_UTTERANCES;
    const signal = options.signal;
    if (signal !== undefined && signal.aborted) {
      await source.dispose();
      return err(appError("CANCELLED", "replay cancelled before start"));
    }
    let adopted: { sessionId: string; streamId: string } | undefined;
    let expectedSeq = 0;
    const utterances = new Map<string, TrackedUtterance>();
    const counts = { applied: 0, duplicates: 0, stale: 0, gaps: 0, missing: 0 };
    try {
      for await (const raw of source.events) {
        if (signal !== undefined && signal.aborted) {
          return err(appError("CANCELLED", "replay cancelled"));
        }
        const parsed = streamEventSchema.safeParse(raw);
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
        if (adopted === undefined) {
          adopted = { sessionId: event.sessionId, streamId: event.streamId };
        } else if (event.sessionId !== adopted.sessionId || event.streamId !== adopted.streamId) {
          return err(appError("VALIDATION_FAILED", "replay event identity mismatch"));
        }
        if (event.seq > expectedSeq) {
          counts.gaps += 1;
          counts.missing += event.seq - expectedSeq;
          await sink({ type: "gap", from: expectedSeq, to: event.seq });
        }
        const applied = this.applyEvent(event, utterances, counts, maxUtterances);
        if (applied.isErr()) {
          return err(applied.error);
        }
        await sink(applied.value);
        if (event.seq >= expectedSeq) {
          expectedSeq = event.seq + 1;
        }
      }
      if (adopted === undefined) {
        return err(appError("VALIDATION_FAILED", "replay fixture contains no events"));
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
      await source.dispose();
    }
  }

  private applyEvent(
    event: StreamEvent,
    utterances: Map<string, TrackedUtterance>,
    counts: { applied: number; duplicates: number; stale: number },
    maxUtterances: number,
  ): Result<SessionOutput, AppError> {
    const stored = utterances.get(event.utteranceId);
    if (stored === undefined) {
      if (utterances.size >= maxUtterances) {
        return err(appError("VALIDATION_FAILED", "session utterance capacity exceeded"));
      }
      utterances.set(event.utteranceId, {
        revision: event.revision,
        text: event.text,
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
    if (event.revision === stored.revision) {
      if (event.text !== stored.text) {
        return err(appError("VALIDATION_FAILED", "contradictory replay event"));
      }
      counts.duplicates += 1;
      return ok({
        type: "duplicate",
        seq: event.seq,
        utteranceId: event.utteranceId,
        revision: event.revision,
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
    utterances.set(event.utteranceId, {
      revision: event.revision,
      text: event.text,
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
