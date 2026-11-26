import { createHash } from "node:crypto";

import { appError, isAppError, toAppError, type AppError } from "@kernel/errors";
import type { Admission, AppliedEvidence, OperationCounts } from "@modules/session/persistence";
import { and, eq } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";

import type { EvidenceDatabase } from "./database.js";
import { evidenceEvents, evidenceGaps, operations, outboxJobs } from "./schema.js";

export type EvidenceEventInput = AppliedEvidence & { readonly opId: string };

const JOB_KIND = "evidence-committed";
const DEFAULT_MAX_ATTEMPTS = 5;

function invalid(message: string): AppError {
  return appError("VALIDATION_FAILED", message);
}

function jobIdFor(opId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([opId, JOB_KIND]))
    .digest("hex");
}

function operationOf(handle: EvidenceDatabase, opId: string) {
  return handle.db.select().from(operations).where(eq(operations.opId, opId)).get();
}

export function admitOperation(
  handle: EvidenceDatabase,
  opId: string,
  sourceFingerprint: string,
): Result<Admission, AppError> {
  try {
    const existing = operationOf(handle, opId);
    if (existing === undefined) {
      handle.db
        .insert(operations)
        .values({ opId, status: "running", fingerprint: sourceFingerprint })
        .run();
      return ok({ mode: "new" });
    }
    if (existing.fingerprint !== sourceFingerprint) {
      return err(invalid("conflicting operation identity reuse"));
    }
    if (existing.status === "completed") {
      if (existing.sessionId === null || existing.streamId === null) {
        return err(appError("INTERNAL", "completed operation is missing its identity"));
      }
      return ok({
        mode: "verify",
        fingerprint: sourceFingerprint,
        summary: {
          applied: existing.applied,
          duplicates: existing.duplicates,
          stale: existing.stale,
          gaps: existing.gaps,
          missing: existing.missing,
          sessionId: existing.sessionId,
          streamId: existing.streamId,
        },
      });
    }
    return ok({ mode: "resume" });
  } catch (thrown: unknown) {
    return err(toAppError(thrown, "evidence write failed"));
  }
}

function sameContent(
  row: { utteranceId: string; revision: number; kind: string; contentHash: string },
  input: EvidenceEventInput,
): boolean {
  return (
    row.utteranceId === input.utteranceId &&
    row.revision === input.revision &&
    row.kind === input.kind &&
    row.contentHash === input.contentHash
  );
}

export function recordEvent(
  handle: EvidenceDatabase,
  input: EvidenceEventInput,
): Result<"inserted" | "duplicate", AppError> {
  try {
    return ok(
      handle.db.transaction((tx) => {
        const operation = tx.select().from(operations).where(eq(operations.opId, input.opId)).get();
        if (operation === undefined || operation.status !== "running") {
          throw invalid("evidence requires an admitted running operation");
        }
        if (operation.sessionId === null) {
          const owner = tx
            .select()
            .from(operations)
            .where(
              and(
                eq(operations.sessionId, input.sessionId),
                eq(operations.streamId, input.streamId),
              ),
            )
            .get();
          if (owner !== undefined && owner.opId !== input.opId) {
            throw invalid("stream already owned by another operation");
          }
          tx.update(operations)
            .set({ sessionId: input.sessionId, streamId: input.streamId })
            .where(eq(operations.opId, input.opId))
            .run();
        } else if (
          operation.sessionId !== input.sessionId ||
          operation.streamId !== input.streamId
        ) {
          throw invalid("evidence does not belong to the admitted operation");
        }
        const bySeq = tx
          .select()
          .from(evidenceEvents)
          .where(
            and(
              eq(evidenceEvents.sessionId, input.sessionId),
              eq(evidenceEvents.streamId, input.streamId),
              eq(evidenceEvents.seq, input.seq),
            ),
          )
          .get();
        if (bySeq !== undefined) {
          if (!sameContent(bySeq, input)) {
            throw invalid("contradictory evidence event");
          }
          return "duplicate" as const;
        }
        const sameRevision = tx
          .select()
          .from(evidenceEvents)
          .where(
            and(
              eq(evidenceEvents.sessionId, input.sessionId),
              eq(evidenceEvents.streamId, input.streamId),
              eq(evidenceEvents.utteranceId, input.utteranceId),
              eq(evidenceEvents.revision, input.revision),
            ),
          )
          .get();
        if (sameRevision !== undefined) {
          const identical =
            sameRevision.contentHash === input.contentHash && sameRevision.kind === input.kind;
          if (identical) {
            return "duplicate" as const;
          }
          const transition =
            sameRevision.kind === "partial" &&
            input.kind === "final" &&
            sameRevision.contentHash === input.contentHash;
          if (!transition) {
            throw invalid("contradictory evidence event");
          }
        } else {
          const aggregate = handle.sqlite
            .prepare(
              `SELECT COALESCE(MAX(revision), -1) AS maxRevision,
                      COALESCE(MAX(kind = 'final'), 0) AS finalized
               FROM evidence_events
               WHERE session_id = ? AND stream_id = ? AND utterance_id = ?`,
            )
            .get(input.sessionId, input.streamId, input.utteranceId) as {
            maxRevision: number;
            finalized: number;
          };
          if (aggregate.finalized === 1 || input.revision < aggregate.maxRevision) {
            throw invalid("contradictory evidence event");
          }
        }
        tx.insert(evidenceEvents)
          .values({
            sessionId: input.sessionId,
            streamId: input.streamId,
            seq: input.seq,
            utteranceId: input.utteranceId,
            revision: input.revision,
            kind: input.kind,
            text: input.text,
            contentHash: input.contentHash,
            opId: input.opId,
          })
          .run();
        return "inserted" as const;
      }),
    );
  } catch (thrown: unknown) {
    if (isAppError(thrown)) {
      return err(thrown);
    }
    if (
      typeof thrown === "object" &&
      thrown !== null &&
      (thrown as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      return err(invalid("stream already owned by another operation"));
    }
    return err(toAppError(thrown, "evidence write failed"));
  }
}

export function recordGap(
  handle: EvidenceDatabase,
  input: { opId: string; sessionId: string; streamId: string; fromSeq: number; toSeq: number },
): Result<void, AppError> {
  try {
    const operation = operationOf(handle, input.opId);
    if (
      operation === undefined ||
      operation.status !== "running" ||
      operation.sessionId !== input.sessionId ||
      operation.streamId !== input.streamId
    ) {
      return err(invalid("evidence does not belong to the admitted operation"));
    }
    handle.db.insert(evidenceGaps).values(input).onConflictDoNothing().run();
    return ok(undefined);
  } catch (thrown: unknown) {
    return err(toAppError(thrown, "evidence write failed"));
  }
}

export function verifyEvent(
  handle: EvidenceDatabase,
  input: Omit<EvidenceEventInput, "opId">,
): Result<void, AppError> {
  const row = handle.db
    .select()
    .from(evidenceEvents)
    .where(
      and(
        eq(evidenceEvents.sessionId, input.sessionId),
        eq(evidenceEvents.streamId, input.streamId),
        eq(evidenceEvents.seq, input.seq),
      ),
    )
    .get();
  if (row === undefined || !sameContent(row, { ...input, opId: "" })) {
    return err(invalid("conflicting operation identity reuse"));
  }
  return ok(undefined);
}

export function completeOperation(
  handle: EvidenceDatabase,
  input: {
    opId: string;
    sessionId: string;
    streamId: string;
    summary: OperationCounts;
    expectedCount: number;
    expectedMaxSeq: number;
  },
): Result<{ status: "committed"; summary: OperationCounts }, AppError> {
  try {
    return ok(
      handle.db.transaction((tx) => {
        const operation = tx.select().from(operations).where(eq(operations.opId, input.opId)).get();
        if (operation === undefined || operation.status !== "running") {
          throw invalid("evidence requires an admitted running operation");
        }
        const aggregate = handle.sqlite
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(MAX(seq), -1) AS maxSeq
             FROM evidence_events WHERE session_id = ? AND stream_id = ?`,
          )
          .get(input.sessionId, input.streamId) as { n: number; maxSeq: number };
        if (aggregate.n !== input.expectedCount || aggregate.maxSeq !== input.expectedMaxSeq) {
          throw invalid("operation evidence does not match durable evidence");
        }
        tx.update(operations)
          .set({
            status: "completed",
            sessionId: input.sessionId,
            streamId: input.streamId,
            ...input.summary,
          })
          .where(eq(operations.opId, input.opId))
          .run();
        tx.insert(outboxJobs)
          .values({
            jobId: jobIdFor(input.opId),
            kind: JOB_KIND,
            sessionId: input.sessionId,
            streamId: input.streamId,
            opId: input.opId,
            status: "pending",
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
          })
          .onConflictDoNothing()
          .run();
        return { status: "committed" as const, summary: input.summary };
      }),
    );
  } catch (thrown: unknown) {
    if (isAppError(thrown)) {
      return err(thrown);
    }
    return err(toAppError(thrown, "evidence write failed"));
  }
}

export function countEvidence(handle: EvidenceDatabase): number {
  const row = handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM evidence_events`).get() as {
    n: number;
  };
  return row.n;
}

export function listEvidence(
  handle: EvidenceDatabase,
  sessionId: string,
): Array<{ seq: number; utteranceId: string; text: string }> {
  return handle.sqlite
    .prepare(
      `SELECT seq, utterance_id AS utteranceId, text FROM evidence_events
       WHERE session_id = ? ORDER BY seq`,
    )
    .all(sessionId) as Array<{ seq: number; utteranceId: string; text: string }>;
}

export function listGaps(
  handle: EvidenceDatabase,
  sessionId: string,
): Array<{ fromSeq: number; toSeq: number }> {
  return handle.sqlite
    .prepare(
      `SELECT from_seq AS fromSeq, to_seq AS toSeq FROM evidence_gaps
       WHERE session_id = ? ORDER BY from_seq`,
    )
    .all(sessionId) as Array<{ fromSeq: number; toSeq: number }>;
}
