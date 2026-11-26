import { randomUUID } from "node:crypto";

import { appError, toAppError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

import type { EvidenceDatabase } from "./database.js";

export interface ClaimedJob {
  readonly jobId: string;
  readonly kind: string;
  readonly sessionId: string;
  readonly streamId: string;
  readonly opId: string;
  readonly ownerToken: string;
  readonly attempts: number;
}

function invalid(message: string): AppError {
  return appError("VALIDATION_FAILED", message);
}

export function claimJobs(
  handle: EvidenceDatabase,
  input: { limit: number; leaseMs: number; nowMs: number },
): Result<ClaimedJob[], AppError> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs < 1 ||
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0
  ) {
    return err(invalid("outbox claim limits are invalid"));
  }
  try {
    return ok(
      handle.sqlite
        .transaction(() => {
          handle.sqlite
            .prepare(
              `UPDATE outbox_jobs SET status = 'failed', owner_token = NULL, lease_expires_at = NULL
             WHERE status = 'claimed' AND lease_expires_at <= ? AND attempts >= max_attempts`,
            )
            .run(input.nowMs);
          const rows = handle.sqlite
            .prepare(
              `SELECT job_id, kind, session_id, stream_id, op_id, attempts
             FROM outbox_jobs
             WHERE (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= ?))
               AND attempts < max_attempts
             ORDER BY rowid LIMIT ?`,
            )
            .all(input.nowMs, input.limit) as Array<{
            job_id: string;
            kind: string;
            session_id: string;
            stream_id: string;
            op_id: string;
            attempts: number;
          }>;
          const claimed: ClaimedJob[] = [];
          for (const row of rows) {
            const token = randomUUID();
            const changed = handle.sqlite
              .prepare(
                `UPDATE outbox_jobs
               SET status = 'claimed', owner_token = ?, lease_expires_at = ?, attempts = attempts + 1
               WHERE job_id = ?
                 AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= ?))`,
              )
              .run(token, input.nowMs + input.leaseMs, row.job_id, input.nowMs);
            if (changed.changes === 1) {
              claimed.push({
                jobId: row.job_id,
                kind: row.kind,
                sessionId: row.session_id,
                streamId: row.stream_id,
                opId: row.op_id,
                ownerToken: token,
                attempts: row.attempts + 1,
              });
            }
          }
          return claimed;
        })
        .immediate(),
    );
  } catch (thrown: unknown) {
    return err(toAppError(thrown, "outbox claim failed"));
  }
}

export function ackJob(
  handle: EvidenceDatabase,
  jobId: string,
  ownerToken: string,
  nowMs: number,
): Result<void, AppError> {
  try {
    const changed = handle.sqlite
      .prepare(
        `UPDATE outbox_jobs SET status = 'done', owner_token = NULL, lease_expires_at = NULL
         WHERE job_id = ? AND owner_token = ? AND status = 'claimed' AND lease_expires_at > ?`,
      )
      .run(jobId, ownerToken, nowMs);
    if (changed.changes !== 1) {
      return err(invalid("stale outbox claim owner"));
    }
    return ok(undefined);
  } catch (thrown: unknown) {
    return err(toAppError(thrown, "outbox acknowledgement failed"));
  }
}

export function failJob(
  handle: EvidenceDatabase,
  jobId: string,
  ownerToken: string,
  nowMs: number,
  options: { terminal?: boolean } = {},
): Result<void, AppError> {
  try {
    const row = handle.sqlite
      .prepare(`SELECT attempts, max_attempts FROM outbox_jobs WHERE job_id = ?`)
      .get(jobId) as { attempts: number; max_attempts: number } | undefined;
    if (row === undefined) {
      return err(invalid("unknown outbox job"));
    }
    const terminal = options.terminal === true || row.attempts >= row.max_attempts;
    const changed = handle.sqlite
      .prepare(
        `UPDATE outbox_jobs SET status = ?, owner_token = NULL, lease_expires_at = NULL
         WHERE job_id = ? AND owner_token = ? AND status = 'claimed' AND lease_expires_at > ?`,
      )
      .run(terminal ? "failed" : "pending", jobId, ownerToken, nowMs);
    if (changed.changes !== 1) {
      return err(invalid("stale outbox claim owner"));
    }
    return ok(undefined);
  } catch (thrown: unknown) {
    return err(toAppError(thrown, "outbox failure handling failed"));
  }
}

export function countJobs(handle: EvidenceDatabase, status?: string): number {
  const row =
    status === undefined
      ? (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM outbox_jobs`).get() as { n: number })
      : (handle.sqlite
          .prepare(`SELECT COUNT(*) AS n FROM outbox_jobs WHERE status = ?`)
          .get(status) as { n: number });
  return row.n;
}
