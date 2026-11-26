import { createHash } from "node:crypto";

import { appError, toAppError, type AppError } from "@kernel/errors";
import { type ReplaySummary, type SessionOutput } from "@modules/session/events";
import { stripFormatting } from "@platform/output";
import { err, ok, type Result } from "neverthrow";

import type { CliOutput } from "./output.js";

interface ReplayInput {
  readonly fixture: string;
  readonly json: boolean;
  readonly signal: AbortSignal;
  readonly output: CliOutput;
  readonly persist?: boolean;
  readonly operationId?: string;
}

export type ReplayPort = (input: ReplayInput) => Promise<Result<ReplaySummary, AppError>>;

interface ReplayEngine {
  run(
    source: {
      readonly events: AsyncIterable<unknown>;
      dispose(): Promise<void>;
    },
    sink: (event: SessionOutput) => void | Promise<void>,
    options: { readonly signal: AbortSignal },
  ): Promise<Result<ReplaySummary, AppError>>;
}

interface EvidenceSink {
  recordEvent(input: {
    sessionId: string;
    streamId: string;
    seq: number;
    utteranceId: string;
    revision: number;
    kind: "partial" | "final";
    text: string;
    contentHash: string;
  }): Result<"inserted" | "duplicate", AppError>;
  recordGap(input: {
    sessionId: string;
    streamId: string;
    fromSeq: number;
    toSeq: number;
  }): Result<void, AppError>;
  completeOperation(input: {
    opId: string;
    fingerprint: string;
    sessionId: string;
    streamId: string;
    summary: {
      applied: number;
      duplicates: number;
      stale: number;
      gaps: number;
      missing: number;
    };
  }): Result<
    {
      status: "committed" | "existing";
      summary: {
        applied: number;
        duplicates: number;
        stale: number;
        gaps: number;
        missing: number;
      };
    },
    AppError
  >;
  close(): void;
}

export interface ReplayDeps {
  readonly runtime: ReplayEngine;
  readonly openSource: (
    fixture: string,
    signal: AbortSignal,
  ) => Promise<
    Result<{ readonly events: AsyncIterable<unknown>; dispose(): Promise<void> }, AppError>
  >;
  readonly openStore?: () => Promise<Result<EvidenceSink, AppError>>;
  readonly newOperationId?: () => string;
}

function formatReplayEvent(event: SessionOutput): string {
  switch (event.type) {
    case "applied":
      return `[seq=${event.seq}] ${event.utteranceId}#r${event.revision} ${event.kind.toUpperCase()}: ${event.text}`;
    case "duplicate":
      return `[seq=${event.seq}] ${event.utteranceId}#r${event.revision} DUPLICATE: ignored`;
    case "stale":
      return `[seq=${event.seq}] ${event.utteranceId}#r${event.revision} STALE (${event.reason}): ignored`;
    case "gap":
      return `[gap] missing seq ${event.from}..${event.to - 1}`;
    case "completed": {
      const s = event.summary;
      return `replay complete: applied=${s.applied} duplicates=${s.duplicates} stale=${s.stale} gaps=${s.gaps} missing=${s.missing}`;
    }
  }
}

export function createReplayPort(deps: ReplayDeps): ReplayPort {
  return async (input) => {
    const emit = async (event: SessionOutput): Promise<void> => {
      const line = input.json ? JSON.stringify(event) : stripFormatting(formatReplayEvent(event));
      await input.output.out(line);
    };
    const opened = await deps.openSource(input.fixture, input.signal);
    if (opened.isErr()) {
      return err(opened.error);
    }
    if (input.persist !== true) {
      try {
        return await deps.runtime.run(opened.value, emit, { signal: input.signal });
      } catch (thrown: unknown) {
        return err(toAppError(thrown, "replay failed"));
      }
    }
    if (deps.openStore === undefined) {
      await opened.value.dispose().catch(() => undefined);
      return err(appError("VALIDATION_FAILED", "persistence requires native module authorization"));
    }
    const storeResult = await deps.openStore();
    if (storeResult.isErr()) {
      await opened.value.dispose().catch(() => undefined);
      return err(storeResult.error);
    }
    const store = storeResult.value;
    const operationId = input.operationId ?? deps.newOperationId?.() ?? "";
    if (operationId === "") {
      store.close();
      await opened.value.dispose().catch(() => undefined);
      return err(appError("VALIDATION_FAILED", "persistent replay requires an operation id"));
    }
    const fingerprint = createHash("sha256");
    let identity: { sessionId: string; streamId: string } | undefined;
    const captureIdentity = (raw: unknown): void => {
      if (identity !== undefined || typeof raw !== "object" || raw === null) {
        return;
      }
      const record = raw as Record<string, unknown>;
      if (typeof record["sessionId"] === "string" && typeof record["streamId"] === "string") {
        identity = { sessionId: record["sessionId"], streamId: record["streamId"] };
      }
    };
    const peekingSource = {
      events: (async function* (): AsyncGenerator<unknown, void, void> {
        for await (const raw of opened.value.events) {
          captureIdentity(raw);
          yield raw;
        }
      })(),
      dispose: opened.value.dispose,
    };
    try {
      const outcome = await deps.runtime.run(
        peekingSource,
        async (event) => {
          if (event.type === "completed") {
            identity = { sessionId: event.summary.sessionId, streamId: event.summary.streamId };
            return;
          }
          if (event.type === "applied") {
            const contentHash = createHash("sha256").update(event.text).digest("hex");
            fingerprint.update(
              JSON.stringify([
                event.seq,
                event.utteranceId,
                event.revision,
                event.kind,
                contentHash,
              ]),
            );
            if (identity !== undefined) {
              const recorded = store.recordEvent({
                sessionId: identity.sessionId,
                streamId: identity.streamId,
                seq: event.seq,
                utteranceId: event.utteranceId,
                revision: event.revision,
                kind: event.kind,
                text: event.text,
                contentHash,
              });
              if (recorded.isErr()) {
                throw recorded.error;
              }
            }
          } else if (event.type === "gap" && identity !== undefined) {
            fingerprint.update(JSON.stringify(["gap", event.from, event.to]));
            const recorded = store.recordGap({
              sessionId: identity.sessionId,
              streamId: identity.streamId,
              fromSeq: event.from,
              toSeq: event.to,
            });
            if (recorded.isErr()) {
              throw recorded.error;
            }
          }
          if (identity === undefined && event.type === "applied") {
            throw appError("VALIDATION_FAILED", "persistent replay lost session identity");
          }
          await emit(event);
        },
        { signal: input.signal },
      );
      if (outcome.isErr()) {
        return outcome;
      }
      if (identity === undefined) {
        identity = { sessionId: outcome.value.sessionId, streamId: outcome.value.streamId };
      }
      const completed = store.completeOperation({
        opId: operationId,
        fingerprint: fingerprint.digest("hex"),
        sessionId: identity.sessionId,
        streamId: identity.streamId,
        summary: {
          applied: outcome.value.applied,
          duplicates: outcome.value.duplicates,
          stale: outcome.value.stale,
          gaps: outcome.value.gaps,
          missing: outcome.value.missing,
        },
      });
      if (completed.isErr()) {
        return err(completed.error);
      }
      const summary: ReplaySummary = {
        sessionId: identity.sessionId,
        streamId: identity.streamId,
        ...completed.value.summary,
      };
      await emit({ type: "completed", summary });
      return ok(summary);
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "replay failed"));
    } finally {
      store.close();
    }
  };
}
