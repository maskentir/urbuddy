import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const evidenceEvents = sqliteTable(
  "evidence_events",
  {
    sessionId: text("session_id").notNull(),
    streamId: text("stream_id").notNull(),
    seq: integer("seq").notNull(),
    utteranceId: text("utterance_id").notNull(),
    revision: integer("revision").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.streamId, table.seq] }),
    uniqueIndex("evidence_utterance_revision").on(
      table.sessionId,
      table.utteranceId,
      table.revision,
    ),
  ],
);

export const evidenceGaps = sqliteTable(
  "evidence_gaps",
  {
    sessionId: text("session_id").notNull(),
    streamId: text("stream_id").notNull(),
    fromSeq: integer("from_seq").notNull(),
    toSeq: integer("to_seq").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.streamId, table.fromSeq, table.toSeq] }),
  ],
);

export const operations = sqliteTable("operations", {
  opId: text("op_id").primaryKey(),
  fingerprint: text("fingerprint").notNull(),
  sessionId: text("session_id").notNull(),
  streamId: text("stream_id").notNull(),
  applied: integer("applied").notNull(),
  duplicates: integer("duplicates").notNull(),
  stale: integer("stale").notNull(),
  gaps: integer("gaps").notNull(),
  missing: integer("missing").notNull(),
});

export const outboxJobs = sqliteTable("outbox_jobs", {
  jobId: text("job_id").primaryKey(),
  kind: text("kind").notNull(),
  sessionId: text("session_id").notNull(),
  streamId: text("stream_id").notNull(),
  opId: text("op_id")
    .notNull()
    .references(() => operations.opId),
  status: text("status").notNull(),
  ownerToken: text("owner_token"),
  leaseExpiresAt: integer("lease_expires_at"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull(),
});
