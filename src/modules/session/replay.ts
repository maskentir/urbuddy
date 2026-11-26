import { createHash } from "node:crypto";

import { appError, toAppError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

import type { ReplaySummary, SessionOutput } from "./events.js";
import type { EvidencePersistence } from "./persistence.js";
import { SessionRuntime, type ReplaySource } from "./runtime.js";

export interface ReplayOperationInput {
  readonly source: ReplaySource;
  readonly sink: (event: SessionOutput) => void | Promise<void>;
  readonly signal: AbortSignal;
  readonly persistence?: EvidencePersistence;
  readonly operationId?: string;
  readonly sourceFingerprint?: string;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function disposeQuietly(source: ReplaySource): Promise<void> {
  try {
    await source.dispose();
  } catch {
    return;
  }
}

export async function runReplay(
  input: ReplayOperationInput,
): Promise<Result<ReplaySummary, AppError>> {
  const runtime = new SessionRuntime();
  if (input.persistence === undefined) {
    try {
      return await runtime.run(input.source, input.sink, { signal: input.signal });
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "replay failed"));
    }
  }
  const persistence = input.persistence;
  let outcome: Result<ReplaySummary, AppError>;
  try {
    outcome = await runPersistent(runtime, persistence, input);
  } catch (thrown: unknown) {
    outcome = err(toAppError(thrown, "replay failed"));
  }
  try {
    await persistence.close();
  } catch (thrown: unknown) {
    if (outcome.isOk()) {
      return err(toAppError(thrown, "replay cleanup failed"));
    }
    return outcome;
  }
  if (outcome.isOk()) {
    if (input.signal.aborted) {
      return err(appError("CANCELLED", "replay cancelled"));
    }
    try {
      await input.sink({ type: "completed", summary: outcome.value });
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "replay failed"));
    }
  }
  return outcome;
}

async function runPersistent(
  runtime: SessionRuntime,
  persistence: EvidencePersistence,
  input: ReplayOperationInput,
): Promise<Result<ReplaySummary, AppError>> {
  const operationId = input.operationId ?? "";
  const sourceFingerprint = input.sourceFingerprint ?? "";
  if (operationId === "" || sourceFingerprint === "") {
    await disposeQuietly(input.source);
    return err(
      appError(
        "VALIDATION_FAILED",
        "persistent replay requires an operation id and source fingerprint",
      ),
    );
  }
  const admission = await persistence.admit(operationId, sourceFingerprint);
  if (admission.isErr()) {
    await disposeQuietly(input.source);
    return err(admission.error);
  }
  const mode = admission.value.mode;
  let evidenceCount = 0;
  let maxSeq = -1;
  let identity: { sessionId: string; streamId: string } | undefined;
  const pendingGaps: Array<{ from: number; to: number }> = [];
  const recordGapBound = async (from: number, to: number): Promise<void> => {
    if (identity === undefined) {
      throw appError("VALIDATION_FAILED", "persistent replay lost session identity");
    }
    const recorded = await persistence.recordGap({
      opId: operationId,
      sessionId: identity.sessionId,
      streamId: identity.streamId,
      fromSeq: from,
      toSeq: to,
    });
    if (recorded.isErr()) {
      throw recorded.error;
    }
  };
  const outcome = await runtime.run(
    input.source,
    async (event) => {
      if (event.type === "completed") {
        return;
      }
      if (event.type === "applied") {
        if (identity === undefined) {
          identity = { sessionId: event.sessionId, streamId: event.streamId };
          if (mode !== "verify") {
            for (const gap of pendingGaps) {
              await recordGapBound(gap.from, gap.to);
            }
          }
          pendingGaps.length = 0;
        }
        const applied = {
          sessionId: event.sessionId,
          streamId: event.streamId,
          seq: event.seq,
          utteranceId: event.utteranceId,
          revision: event.revision,
          kind: event.kind,
          text: event.text,
          contentHash: hashText(event.text),
        };
        evidenceCount += 1;
        maxSeq = Math.max(maxSeq, event.seq);
        const recorded =
          mode === "verify"
            ? await persistence.verify(applied)
            : await persistence.record(applied, operationId);
        if (recorded.isErr()) {
          throw recorded.error;
        }
      } else if (event.type === "gap" && mode !== "verify") {
        if (identity === undefined) {
          pendingGaps.push({ from: event.from, to: event.to });
        } else {
          await recordGapBound(event.from, event.to);
        }
      }
      await input.sink(event);
    },
    { signal: input.signal },
  );
  if (outcome.isErr()) {
    return outcome;
  }
  if (mode === "verify" && admission.value.mode === "verify") {
    return ok({
      sessionId: admission.value.summary.sessionId,
      streamId: admission.value.summary.streamId,
      applied: admission.value.summary.applied,
      duplicates: outcome.value.duplicates,
      stale: outcome.value.stale,
      gaps: admission.value.summary.gaps,
      missing: admission.value.summary.missing,
    });
  }
  const completed = await persistence.complete({
    opId: operationId,
    sessionId: outcome.value.sessionId,
    streamId: outcome.value.streamId,
    summary: {
      applied: outcome.value.applied,
      duplicates: outcome.value.duplicates,
      stale: outcome.value.stale,
      gaps: outcome.value.gaps,
      missing: outcome.value.missing,
    },
    expectedCount: evidenceCount,
    expectedMaxSeq: maxSeq,
  });
  if (completed.isErr()) {
    return err(completed.error);
  }
  return outcome;
}
