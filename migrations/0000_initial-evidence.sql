CREATE TABLE `evidence_events` (
	`session_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`seq` integer NOT NULL,
	`utterance_id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`content_hash` text NOT NULL,
	`op_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `stream_id`, `seq`),
	FOREIGN KEY (`op_id`) REFERENCES `operations`(`op_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `evidence_utterance` ON `evidence_events` (`session_id`,`stream_id`,`utterance_id`,`revision`);--> statement-breakpoint
CREATE TABLE `evidence_gaps` (
	`session_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`from_seq` integer NOT NULL,
	`to_seq` integer NOT NULL,
	`op_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `stream_id`, `from_seq`, `to_seq`),
	FOREIGN KEY (`op_id`) REFERENCES `operations`(`op_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`op_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`fingerprint` text,
	`session_id` text,
	`stream_id` text,
	`applied` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`stale` integer DEFAULT 0 NOT NULL,
	`gaps` integer DEFAULT 0 NOT NULL,
	`missing` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_stream_owner` ON `operations` (`session_id`,`stream_id`) WHERE "operations"."session_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `outbox_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`session_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`op_id` text NOT NULL,
	`status` text NOT NULL,
	`owner_token` text,
	`lease_expires_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	FOREIGN KEY (`op_id`) REFERENCES `operations`(`op_id`) ON UPDATE no action ON DELETE no action
);
