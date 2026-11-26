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
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
  }
  return outcome;
}

async function runPersistent(
  runtime: SessionRuntime,
  persistence: EvidencePersistence,
  input: ReplayOperationInput,
): Promise<Result<ReplaySummary, AppError>> {
  const operationId = input.operationId ?? "";
  if (operationId === "") {
    return err(appError("VALIDATION_FAILED", "persistent replay requires an operation id"));
  }
  const admission = await persistence.admit(operationId);
  if (admission.isErr()) {
    return err(admission.error);
  }
  const mode = admission.value.mode;
  const fingerprint = createHash("sha256");
  const evidenceSeqs: number[] = [];
  let identity: { sessionId: string; streamId: string } | undefined;
  let fingerprintSeeded = false;
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
        if (!fingerprintSeeded) {
          fingerprint.update(
            JSON.stringify(["session", event.summary.sessionId, event.summary.streamId]),
          );
          fingerprintSeeded = true;
        }
        return;
      }
      if (event.type === "applied") {
        if (identity === undefined) {
          identity = { sessionId: event.sessionId, streamId: event.streamId };
          fingerprint.update(JSON.stringify(["session", identity.sessionId, identity.streamId]));
          fingerprintSeeded = true;
          for (const gap of pendingGaps) {
            if (mode !== "verify") {
              await recordGapBound(gap.from, gap.to);
            }
          }
          pendingGaps.length = 0;
        }
        const contentHash = hashText(event.text);
        fingerprint.update(
          JSON.stringify([event.seq, event.utteranceId, event.revision, event.kind, contentHash]),
        );
        evidenceSeqs.push(event.seq);
        const applied = {
          sessionId: event.sessionId,
          streamId: event.streamId,
          seq: event.seq,
          utteranceId: event.utteranceId,
          revision: event.revision,
          kind: event.kind,
          text: event.text,
          contentHash,
        };
        const recorded =
          mode === "verify"
            ? await persistence.verify(applied)
            : await persistence.record(applied, operationId);
        if (recorded.isErr()) {
          throw recorded.error;
        }
      } else if (event.type === "gap") {
        fingerprint.update(JSON.stringify(["gap", event.from, event.to]));
        if (mode !== "verify") {
          if (identity === undefined) {
            pendingGaps.push({ from: event.from, to: event.to });
          } else {
            await recordGapBound(event.from, event.to);
          }
        }
      }
      await input.sink(event);
    },
    { signal: input.signal },
  );
  if (outcome.isErr()) {
    return outcome;
  }
  const digest = fingerprint.digest("hex");
  if (mode === "verify" && admission.value.mode === "verify") {
    if (digest !== admission.value.fingerprint) {
      return err(appError("VALIDATION_FAILED", "conflicting operation identity reuse"));
    }
    const summary: ReplaySummary = {
      sessionId: admission.value.summary.sessionId,
      streamId: admission.value.summary.streamId,
      applied: admission.value.summary.applied,
      duplicates: outcome.value.duplicates,
      stale: outcome.value.stale,
      gaps: admission.value.summary.gaps,
      missing: admission.value.summary.missing,
    };
    await input.sink({ type: "completed", summary });
    return ok(summary);
  }
  const completed = await persistence.complete({
    opId: operationId,
    fingerprint: digest,
    sessionId: outcome.value.sessionId,
    streamId: outcome.value.streamId,
    summary: {
      applied: outcome.value.applied,
      duplicates: outcome.value.duplicates,
      stale: outcome.value.stale,
      gaps: outcome.value.gaps,
      missing: outcome.value.missing,
    },
    evidenceSeqs,
  });
  if (completed.isErr()) {
    return err(completed.error);
  }
  await input.sink({ type: "completed", summary: outcome.value });
  return outcome;
}
