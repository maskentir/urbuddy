import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { appError, toAppError, type AppError } from "@kernel/errors";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { err, ok, type Result } from "neverthrow";

import { evidenceEvents, evidenceGaps, operations, outboxJobs } from "./schema.js";

const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE evidence_events (
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  utterance_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (session_id, stream_id, seq)
);
CREATE UNIQUE INDEX evidence_utterance_revision
  ON evidence_events (session_id, utterance_id, revision);
CREATE TABLE evidence_gaps (
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, stream_id, from_seq, to_seq)
);
CREATE TABLE operations (
  op_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  applied INTEGER NOT NULL,
  duplicates INTEGER NOT NULL,
  stale INTEGER NOT NULL,
  gaps INTEGER NOT NULL,
  missing INTEGER NOT NULL
);
CREATE TABLE outbox_jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  op_id TEXT NOT NULL REFERENCES operations(op_id),
  status TEXT NOT NULL,
  owner_token TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL
);
`,
];

export interface EvidenceSettings {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
  readonly busyTimeout: number;
  readonly fullfsync: number;
  readonly userVersion: number;
}

export interface EvidenceEventInput {
  readonly sessionId: string;
  readonly streamId: string;
  readonly seq: number;
  readonly utteranceId: string;
  readonly revision: number;
  readonly kind: "partial" | "final";
  readonly text: string;
  readonly contentHash: string;
}

export interface OperationSummaryInput {
  readonly applied: number;
  readonly duplicates: number;
  readonly stale: number;
  readonly gaps: number;
  readonly missing: number;
}

export interface ClaimedJob {
  readonly jobId: string;
  readonly kind: string;
  readonly sessionId: string;
  readonly streamId: string;
  readonly opId: string;
  readonly ownerToken: string;
  readonly attempts: number;
}

export interface EvidenceStoreOptions {
  readonly busyTimeoutMs?: number;
  readonly maxPageCount?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 250;
const DEFAULT_MAX_ATTEMPTS = 5;
const EVIDENCE_JOB_KIND = "evidence-committed";

function invalid(message: string): AppError {
  return appError("VALIDATION_FAILED", message);
}

function jobIdFor(sessionId: string, streamId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, streamId, EVIDENCE_JOB_KIND]))
    .digest("hex");
}

export class EvidenceStore {
  private closed = false;

  private constructor(
    private readonly sqlite: InstanceType<typeof Database>,
    private readonly db: BetterSQLite3Database,
    readonly settings: EvidenceSettings,
  ) {}

  static open(path: string, options: EvidenceStoreOptions = {}): Result<EvidenceStore, AppError> {
    let sqlite: InstanceType<typeof Database> | undefined;
    try {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        return err(appError("INTERNAL", "evidence store open failed"));
      }
      sqlite = new Database(path);
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = FULL");
      sqlite.pragma("foreign_keys = ON");
      sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
      sqlite.pragma("fullfsync = ON");
      if (options.maxPageCount !== undefined) {
        sqlite.pragma(`max_page_count = ${options.maxPageCount}`);
      }
      const settings = readSettings(sqlite);
      if (
        settings.journalMode !== "wal" ||
        settings.synchronous !== 2 ||
        settings.foreignKeys !== 1
      ) {
        sqlite.close();
        return err(appError("INTERNAL", "evidence store durability settings not in effect"));
      }
      applyMigrations(sqlite);
      const after = readSettings(sqlite);
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(file)) {
          chmodSync(file, 0o600);
        }
      }
      return ok(new EvidenceStore(sqlite, drizzle(sqlite), after));
    } catch (thrown: unknown) {
      sqlite?.close();
      return err(toAppError(thrown, "evidence store open failed"));
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.sqlite.close();
    }
  }

  recordEvent(input: EvidenceEventInput): Result<"inserted" | "duplicate", AppError> {
    try {
      return ok(
        this.db.transaction((tx) => {
          const existing = tx
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
          if (existing !== undefined) {
            if (
              existing.utteranceId !== input.utteranceId ||
              existing.revision !== input.revision ||
              existing.kind !== input.kind ||
              existing.contentHash !== input.contentHash
            ) {
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
                eq(evidenceEvents.utteranceId, input.utteranceId),
                eq(evidenceEvents.revision, input.revision),
              ),
            )
            .get();
          if (sameRevision !== undefined) {
            if (
              sameRevision.kind !== input.kind ||
              sameRevision.contentHash !== input.contentHash
            ) {
              throw invalid("contradictory evidence event");
            }
            return "duplicate" as const;
          }
          tx.insert(evidenceEvents).values(input).run();
          return "inserted" as const;
        }),
      );
    } catch (thrown: unknown) {
      if (
        typeof thrown === "object" &&
        thrown !== null &&
        (thrown as { code?: unknown }).code === "VALIDATION_FAILED"
      ) {
        return err(thrown as AppError);
      }
      return err(toAppError(thrown, "evidence write failed"));
    }
  }

  recordGap(input: {
    sessionId: string;
    streamId: string;
    fromSeq: number;
    toSeq: number;
  }): Result<void, AppError> {
    try {
      this.db.insert(evidenceGaps).values(input).onConflictDoNothing().run();
      return ok(undefined);
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "evidence write failed"));
    }
  }

  completeOperation(input: {
    opId: string;
    fingerprint: string;
    sessionId: string;
    streamId: string;
    summary: OperationSummaryInput;
  }): Result<{ status: "committed" | "existing"; summary: OperationSummaryInput }, AppError> {
    try {
      return ok(
        this.db.transaction((tx) => {
          const existing = tx
            .select()
            .from(operations)
            .where(eq(operations.opId, input.opId))
            .get();
          if (existing !== undefined) {
            if (existing.fingerprint !== input.fingerprint) {
              throw invalid("conflicting operation identity reuse");
            }
            return {
              status: "existing" as const,
              summary: {
                applied: existing.applied,
                duplicates: existing.duplicates,
                stale: existing.stale,
                gaps: existing.gaps,
                missing: existing.missing,
              },
            };
          }
          tx.insert(operations)
            .values({
              opId: input.opId,
              fingerprint: input.fingerprint,
              sessionId: input.sessionId,
              streamId: input.streamId,
              ...input.summary,
            })
            .run();
          tx.insert(outboxJobs)
            .values({
              jobId: jobIdFor(input.sessionId, input.streamId),
              kind: EVIDENCE_JOB_KIND,
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
      if (
        typeof thrown === "object" &&
        thrown !== null &&
        (thrown as { code?: unknown }).code === "VALIDATION_FAILED"
      ) {
        return err(thrown as AppError);
      }
      return err(toAppError(thrown, "evidence write failed"));
    }
  }

  claimJobs(input: {
    limit: number;
    leaseMs: number;
    nowMs: number;
  }): Result<ClaimedJob[], AppError> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.leaseMs < 1) {
      return err(invalid("outbox claim limits are invalid"));
    }
    try {
      return ok(
        this.sqlite
          .transaction(() => {
            const rows = this.sqlite
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
              const changed = this.sqlite
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

  ackJob(jobId: string, ownerToken: string): Result<void, AppError> {
    try {
      const changed = this.sqlite
        .prepare(
          `UPDATE outbox_jobs SET status = 'done', owner_token = NULL, lease_expires_at = NULL
           WHERE job_id = ? AND owner_token = ? AND status = 'claimed'`,
        )
        .run(jobId, ownerToken);
      if (changed.changes !== 1) {
        return err(invalid("stale outbox claim owner"));
      }
      return ok(undefined);
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "outbox acknowledgement failed"));
    }
  }

  failJob(
    jobId: string,
    ownerToken: string,
    options: { terminal?: boolean } = {},
  ): Result<void, AppError> {
    try {
      const row = this.sqlite
        .prepare(`SELECT attempts, max_attempts FROM outbox_jobs WHERE job_id = ?`)
        .get(jobId) as { attempts: number; max_attempts: number } | undefined;
      if (row === undefined) {
        return err(invalid("unknown outbox job"));
      }
      const terminal = options.terminal === true || row.attempts >= row.max_attempts;
      const changed = this.sqlite
        .prepare(
          `UPDATE outbox_jobs SET status = ?, owner_token = NULL, lease_expires_at = NULL
           WHERE job_id = ? AND owner_token = ? AND status = 'claimed'`,
        )
        .run(terminal ? "failed" : "pending", jobId, ownerToken);
      if (changed.changes !== 1) {
        return err(invalid("stale outbox claim owner"));
      }
      return ok(undefined);
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "outbox failure handling failed"));
    }
  }

  countEvidence(): number {
    const row = this.sqlite.prepare(`SELECT COUNT(*) AS n FROM evidence_events`).get() as {
      n: number;
    };
    return row.n;
  }

  countJobs(status?: string): number {
    const row =
      status === undefined
        ? (this.sqlite.prepare(`SELECT COUNT(*) AS n FROM outbox_jobs`).get() as { n: number })
        : (this.sqlite
            .prepare(`SELECT COUNT(*) AS n FROM outbox_jobs WHERE status = ?`)
            .get(status) as { n: number });
    return row.n;
  }

  listEvidence(sessionId: string): Array<{ seq: number; utteranceId: string; text: string }> {
    return this.sqlite
      .prepare(
        `SELECT seq, utterance_id AS utteranceId, text FROM evidence_events
         WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId) as Array<{ seq: number; utteranceId: string; text: string }>;
  }

  listGaps(sessionId: string): Array<{ fromSeq: number; toSeq: number }> {
    return this.sqlite
      .prepare(
        `SELECT from_seq AS fromSeq, to_seq AS toSeq FROM evidence_gaps
         WHERE session_id = ? ORDER BY from_seq`,
      )
      .all(sessionId) as Array<{ fromSeq: number; toSeq: number }>;
  }
}

function readSettings(sqlite: InstanceType<typeof Database>): EvidenceSettings {
  const journal = sqlite.pragma("journal_mode", { simple: true }) as string;
  const synchronous = sqlite.pragma("synchronous", { simple: true }) as number;
  const foreignKeys = sqlite.pragma("foreign_keys", { simple: true }) as number;
  const busyTimeout = sqlite.pragma("busy_timeout", { simple: true }) as number;
  const fullfsync = sqlite.pragma("fullfsync", { simple: true }) as number;
  const userVersion = sqlite.pragma("user_version", { simple: true }) as number;
  return {
    journalMode: journal,
    synchronous,
    foreignKeys,
    busyTimeout,
    fullfsync,
    userVersion,
  };
}

function applyMigrations(sqlite: InstanceType<typeof Database>): void {
  const current = sqlite.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw invalid("unsupported evidence schema version");
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const migration = MIGRATIONS[version];
    if (migration === undefined) {
      throw invalid("unsupported evidence schema version");
    }
    sqlite.transaction(() => {
      sqlite.exec(migration);
      sqlite.pragma(`user_version = ${version + 1}`);
    })();
  }
}
