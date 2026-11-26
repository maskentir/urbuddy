# ADR-004: SQLite as the authoritative durable store

Status: accepted.

## Context

Transcript evidence, checkpoints, jobs, and learner state all need
crash-safe local durability with transactional semantics, while
graph memory and vector indexes are inherently derived and
rebuildable. Introducing distributed infrastructure for a
single-user application would add operational burden without a
corresponding requirement.

## Decision

SQLite (WAL) is the authoritative durable store, accessed via
better-sqlite3 and Drizzle, with a transactional outbox for durable
background work. Durability settings are defined per database; the
evidence journal carries the strictest policy, and durable
operations are acknowledged only after successful commit. Graphiti
indexes and any vector stores are derived: rebuildable from
authorized sources, never sources of truth, subject to deletion
propagation when a source is removed.

## Consequences

Backup, restore, migration, and retention operate on SQLite files with
versioned schemas. No feature may treat a derived index as evidence.
Redis, Valkey, and queue brokers stay deferred unless a concrete
consumer demonstrates that the transactional outbox is insufficient.
