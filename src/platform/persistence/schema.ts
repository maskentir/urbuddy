import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const operations = sqliteTable("operations", {
  opId: text("op_id").primaryKey(),
  status: text("status").notNull(),
  fingerprint: text("fingerprint"),
  sessionId: text("session_id"),
  streamId: text("stream_id"),
  applied: integer("applied").notNull().default(0),
  duplicates: integer("duplicates").notNull().default(0),
  stale: integer("stale").notNull().default(0),
  gaps: integer("gaps").notNull().default(0),
  missing: integer("missing").notNull().default(0),
});

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
    opId: text("op_id")
      .notNull()
      .references(() => operations.opId),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.streamId, table.seq] })],
);

export const evidenceGaps = sqliteTable(
  "evidence_gaps",
  {
    sessionId: text("session_id").notNull(),
    streamId: text("stream_id").notNull(),
    fromSeq: integer("from_seq").notNull(),
    toSeq: integer("to_seq").notNull(),
    opId: text("op_id")
      .notNull()
      .references(() => operations.opId),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.streamId, table.fromSeq, table.toSeq] }),
  ],
);

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
