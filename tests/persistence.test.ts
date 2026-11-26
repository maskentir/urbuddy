import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runApp } from "@bootstrap/composition";
import { EXIT_CODES } from "@kernel/exit-codes";
import { openEvidenceDatabase } from "@platform/persistence/database";
import {
  admitOperation,
  completeOperation,
  countEvidence,
  listEvidence,
  listGaps,
  recordEvent,
} from "@platform/persistence/evidence";
import { ackJob, claimJobs, countJobs, failJob } from "@platform/persistence/outbox";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
const entry = resolve(root, "src", "bootstrap", "main.ts");

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "urbuddy-persist-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function ev(overrides: Record<string, unknown> = {}) {
  const text = typeof overrides["text"] === "string" ? overrides["text"] : "hello";
  return {
    sessionId: "s-1",
    streamId: "st-1",
    seq: 0,
    utteranceId: "u1",
    revision: 0,
    kind: "partial" as const,
    text,
    contentHash: hash(text),
    opId: "op-1",
    ...overrides,
  };
}

function openStore(dir: string, options?: { busyTimeoutMs?: number; maxPageCount?: number }) {
  const opened = openEvidenceDatabase(join(dir, "evidence.sqlite"), options);
  if (opened.isErr()) {
    throw new Error(`store must open: ${opened.error.message}`);
  }
  admitOperation(opened.value, "op-1");
  return opened.value;
}

const summary = { applied: 1, duplicates: 0, stale: 0, gaps: 0, missing: 0 };

describe("evidence store", () => {
  it("enforces WAL, FULL synchronous, foreign keys, and versioned migrations", () => {
    const dir = tempDir();
    const store = openStore(dir);
    expect(store.settings.journalMode).toBe("wal");
    expect(store.settings.synchronous).toBe(2);
    expect(store.settings.foreignKeys).toBe(1);
    expect(recordEvent(store, ev()).isOk()).toBe(true);
    store.close();
    const reopened = openStore(dir);
    expect(countEvidence(reopened)).toBe(1);
    reopened.close();
  });

  it("rejects unsupported schema versions", () => {
    const dir = tempDir();
    const store = openStore(dir);
    store.close();
    const raw = new Database(join(dir, "evidence.sqlite"));
    raw
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run("future", 9999999999999);
    raw.close();
    expect(openEvidenceDatabase(join(dir, "evidence.sqlite")).isErr()).toBe(true);
  });

  it("deduplicates identical events and rejects contradictions", () => {
    const store = openStore(tempDir());
    expect(recordEvent(store, ev())).toMatchObject({ value: "inserted" });
    expect(recordEvent(store, ev())).toMatchObject({ value: "duplicate" });
    expect(recordEvent(store, ev({ text: "changed", contentHash: hash("changed") })).isErr()).toBe(
      true,
    );
    expect(countEvidence(store)).toBe(1);
    store.close();
  });

  it("keeps identical text from different occurrences distinct", () => {
    const store = openStore(tempDir());
    expect(recordEvent(store, ev({ seq: 0, utteranceId: "u1" })).isOk()).toBe(true);
    expect(recordEvent(store, ev({ seq: 1, utteranceId: "u2" })).isOk()).toBe(true);
    expect(countEvidence(store)).toBe(2);
    store.close();
  });

  it("completes operations atomically with one outbox job and idempotent retry", () => {
    const store = openStore(tempDir());
    recordEvent(store, ev());
    const first = completeOperation(store, {
      opId: "op-1",
      fingerprint: "fp-1",
      sessionId: "s-1",
      streamId: "st-1",
      summary,
      evidenceSeqs: [0],
    });
    expect(first).toMatchObject({ value: { status: "committed" } });
    const readmission = admitOperation(store, "op-1");
    expect(readmission).toMatchObject({ value: { mode: "verify", fingerprint: "fp-1" } });
    expect(countJobs(store)).toBe(1);
    const conflict = completeOperation(store, {
      opId: "op-1",
      fingerprint: "fp-other",
      sessionId: "s-1",
      streamId: "st-1",
      summary,
      evidenceSeqs: [0],
    });
    expect(conflict.isErr()).toBe(true);
    store.close();
  });

  it("claims exclusively across connections, recovers leases, rejects stale owners", () => {
    const dir = tempDir();
    const a = openStore(dir);
    recordEvent(a, ev());
    completeOperation(a, {
      opId: "op-1",
      fingerprint: "fp",
      sessionId: "s-1",
      streamId: "st-1",
      summary,
      evidenceSeqs: [0],
    });
    const b = openStore(dir);
    const claimA = claimJobs(a, { limit: 1, leaseMs: 1000, nowMs: 1000 });
    const claimB = claimJobs(b, { limit: 1, leaseMs: 1000, nowMs: 1000 });
    expect(claimA.isOk() && claimA.value).toHaveLength(1);
    expect(claimB.isOk() && claimB.value).toHaveLength(0);
    if (!claimA.isOk()) throw new Error("claim must succeed");
    const job = claimA.value[0] as { jobId: string; ownerToken: string };
    const recovered = claimJobs(b, { limit: 1, leaseMs: 1000, nowMs: 3000 });
    expect(recovered.isOk() && recovered.value).toHaveLength(1);
    expect(ackJob(a, job.jobId, job.ownerToken, 1500).isErr()).toBe(true);
    if (!recovered.isOk()) throw new Error("recovery claim must succeed");
    const fresh = recovered.value[0] as { jobId: string; ownerToken: string };
    expect(ackJob(b, fresh.jobId, fresh.ownerToken, 3500).isOk()).toBe(true);
    expect(countJobs(b, "done")).toBe(1);
    a.close();
    b.close();
  });

  it("bounds retries to a terminal failure", () => {
    const store = openStore(tempDir());
    recordEvent(store, ev());
    completeOperation(store, {
      opId: "op-1",
      fingerprint: "fp",
      sessionId: "s-1",
      streamId: "st-1",
      summary,
      evidenceSeqs: [0],
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const claim = claimJobs(store, { limit: 1, leaseMs: 1000, nowMs: attempt * 10 });
      if (!claim.isOk() || claim.value.length !== 1) throw new Error("claim must succeed");
      const job = claim.value[0] as { jobId: string; ownerToken: string };
      expect(failJob(store, job.jobId, job.ownerToken, 500).isOk()).toBe(true);
    }
    expect(countJobs(store, "failed")).toBe(1);
    const after = claimJobs(store, { limit: 1, leaseMs: 1000, nowMs: 9999 });
    expect(after.isOk() && after.value).toHaveLength(0);
    store.close();
  });

  it("surfaces capacity failure without partial writes beyond committed rows", () => {
    const store = openStore(tempDir(), { maxPageCount: 12 });
    let inserted = 0;
    let failed = false;
    for (let i = 0; i < 200; i += 1) {
      const text = `payload-${i}-` + "x".repeat(500);
      const result = recordEvent(
        store,
        ev({ seq: i, utteranceId: `u${i}`, text, contentHash: hash(text) }),
      );
      if (result.isOk()) inserted += 1;
      else {
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    expect(countEvidence(store)).toBe(inserted);
    store.close();
  });

  it("observes bounded lock contention outcomes", async () => {
    const dir = tempDir();
    const path = join(dir, "evidence.sqlite");
    const store = openStore(dir, { busyTimeoutMs: 100 });
    const raw = new Database(path);
    raw.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    const blocked = recordEvent(store, ev());
    expect(blocked.isErr()).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    raw.exec("COMMIT");
    raw.close();
    expect(recordEvent(store, ev()).isOk()).toBe(true);
    store.close();
  });
});

describe("persist integration", () => {
  it("creates no database for default replay, doctor, or denied persistence", async () => {
    const dir = tempDir();
    const env = { URBUDDY_DATA_ROOT: dir };
    expect(
      await runApp(["node", "urbuddy", "replay", join(root, "fixtures/replay/basic.ndjson")], env),
    ).toBe(EXIT_CODES.success);
    expect(existsSync(join(dir, "evidence.sqlite"))).toBe(false);
    expect(
      await runApp(
        ["node", "urbuddy", "replay", join(root, "fixtures/replay/basic.ndjson"), "--persist"],
        env,
      ),
    ).toBe(EXIT_CODES.usage);
    expect(existsSync(join(dir, "evidence.sqlite"))).toBe(false);
    expect(await runApp(["node", "urbuddy", "doctor"], env)).toBe(EXIT_CODES.success);
    expect(existsSync(join(dir, "evidence.sqlite"))).toBe(false);
  });

  it("rejects native grants in restricted profiles", async () => {
    const dir = tempDir();
    const code = await runApp(
      [
        "node",
        "urbuddy",
        "replay",
        join(root, "fixtures/replay/basic.ndjson"),
        "--persist",
        "--allow-native",
        "--profile",
        "simulation",
      ],
      { URBUDDY_DATA_ROOT: dir },
    );
    expect(code).toBe(EXIT_CODES.configError);
    expect(existsSync(join(dir, "evidence.sqlite"))).toBe(false);
  });

  it("persists evidence and recovers it after reopening", async () => {
    const dir = tempDir();
    const args = [
      "node",
      "urbuddy",
      "replay",
      join(root, "fixtures/replay/gaps.ndjson"),
      "--persist",
      "--allow-native",
      "--operation-id",
      "op-test-1",
    ];
    expect(await runApp(args, { URBUDDY_DATA_ROOT: dir })).toBe(EXIT_CODES.success);
    const store = openStore(dir);
    expect(countEvidence(store)).toBe(3);
    expect(listEvidence(store, "s-2").map((row) => row.text)).toEqual(["a", "a b", "a b."]);
    expect(listGaps(store, "s-2")).toEqual([{ fromSeq: 1, toSeq: 2 }]);
    expect(countJobs(store, "pending")).toBe(1);
    store.close();
    expect(await runApp(args, { URBUDDY_DATA_ROOT: dir })).toBe(EXIT_CODES.success);
    const again = openStore(dir);
    expect(countEvidence(again)).toBe(3);
    expect(countJobs(again)).toBe(1);
    again.close();
  });

  it("recovers committed evidence after the process is killed mid-replay", async () => {
    const dir = tempDir();
    const fixturePath = join(dir, "big.ndjson");
    const lines = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({
        sessionId: "s-crash",
        streamId: "st-crash",
        seq: i,
        kind: "partial",
        utteranceId: `u${i}`,
        revision: 0,
        text: `word ${i} ` + "x".repeat(100),
      }),
    );
    writeFileSync(fixturePath, lines.join("\n") + "\n", "utf8");
    const args = [
      tsxCli,
      entry,
      "replay",
      fixturePath,
      "--persist",
      "--allow-native",
      "--operation-id",
      "op-crash",
      "--data-root",
      dir,
    ];
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const dbPath = join(dir, "evidence.sqlite");
    let committed = 0;
    for (let attempt = 0; attempt < 400 && child.exitCode === null; attempt += 1) {
      try {
        const probe = new Database(dbPath, { readonly: true });
        const row = probe.prepare("SELECT COUNT(*) AS n FROM evidence_events").get() as {
          n: number;
        };
        committed = row.n;
        probe.close();
      } catch {
        committed = 0;
      }
      if (committed >= 100) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(committed).toBeGreaterThanOrEqual(100);
    expect(child.exitCode).toBeNull();
    if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    }
    await new Promise((resolve) => child.once("exit", resolve));
    const afterKill = openStore(dir);
    const partial = countEvidence(afterKill);
    expect(partial).toBeGreaterThan(0);
    afterKill.close();
    const retry = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    retry.stdout.on("data", (chunk: unknown) => {
      out += String(chunk);
    });
    retry.stderr.on("data", (chunk: unknown) => {
      out += String(chunk);
    });
    const code = await new Promise<number | null>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("retry timed out")), 60000);
      retry.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolvePromise(exitCode);
      });
    });
    expect(code, out.slice(-2000)).toBe(0);
    expect(out).toContain("replay complete:");
    const recovered = openStore(dir);
    expect(countEvidence(recovered)).toBe(4000);
    expect(countJobs(recovered)).toBe(1);
    recovered.close();
  }, 90000);
});

describe("admission and migration regressions", () => {
  it("persists same-revision partial-to-final transition", async () => {
    const dir = tempDir();
    const path = join(dir, "finality.ndjson");
    writeFileSync(
      path,
      [
        JSON.stringify({
          sessionId: "s-f",
          streamId: "st-f",
          seq: 0,
          kind: "partial",
          utteranceId: "u1",
          revision: 0,
          text: "hello",
        }),
        JSON.stringify({
          sessionId: "s-f",
          streamId: "st-f",
          seq: 1,
          kind: "final",
          utteranceId: "u1",
          revision: 0,
          text: "hello",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const code = await runApp(
      [
        "node",
        "urbuddy",
        "replay",
        path,
        "--persist",
        "--allow-native",
        "--operation-id",
        "op-fin",
      ],
      { URBUDDY_DATA_ROOT: dir },
    );
    expect(code).toBe(EXIT_CODES.success);
    const store = openStore(dir);
    expect(countEvidence(store)).toBe(2);
    store.close();
  });

  it("completed operations verify read-only and reject conflicting retries without mutation", async () => {
    const dir = tempDir();
    const args = [
      "node",
      "urbuddy",
      "replay",
      join(root, "fixtures/replay/basic.ndjson"),
      "--persist",
      "--allow-native",
      "--operation-id",
      "op-verify",
    ];
    expect(await runApp(args, { URBUDDY_DATA_ROOT: dir })).toBe(EXIT_CODES.success);
    const before = openStore(dir);
    const countBefore = countEvidence(before);
    before.close();
    const conflictPath = join(dir, "conflict.ndjson");
    writeFileSync(
      conflictPath,
      readFileSync(join(root, "fixtures", "replay", "basic.ndjson"), "utf8") +
        JSON.stringify({
          sessionId: "s-1",
          streamId: "st-1",
          seq: 5,
          kind: "partial",
          utteranceId: "u9",
          revision: 0,
          text: "extra",
        }) +
        "\n",
      "utf8",
    );
    const code = await runApp(
      [
        "node",
        "urbuddy",
        "replay",
        conflictPath,
        "--persist",
        "--allow-native",
        "--operation-id",
        "op-verify",
      ],
      { URBUDDY_DATA_ROOT: dir },
    );
    expect(code).not.toBe(EXIT_CODES.success);
    const after = openStore(dir);
    expect(countEvidence(after)).toBe(countBefore);
    after.close();
  });

  it("applies a durable logical effect once across claim recovery", () => {
    const dir = tempDir();
    const store = openStore(dir);
    recordEvent(store, ev());
    completeOperation(store, {
      opId: "op-1",
      fingerprint: "fp",
      sessionId: "s-1",
      streamId: "st-1",
      summary,
      evidenceSeqs: [0],
    });
    const raw = new Database(join(dir, "evidence.sqlite"));
    raw.exec("CREATE TABLE IF NOT EXISTS test_effects (job_id TEXT PRIMARY KEY)");
    const applyEffect = (jobId: string): void => {
      raw.prepare("INSERT OR IGNORE INTO test_effects (job_id) VALUES (?)").run(jobId);
    };
    const first = claimJobs(store, { limit: 1, leaseMs: 100, nowMs: 0 });
    if (!first.isOk() || first.value.length !== 1) throw new Error("first claim must succeed");
    const firstJob = first.value[0];
    if (firstJob === undefined) throw new Error("first claim must yield a job");
    applyEffect(firstJob.jobId);
    const second = claimJobs(store, { limit: 1, leaseMs: 100, nowMs: 1000 });
    if (!second.isOk() || second.value.length !== 1) throw new Error("recovery claim must succeed");
    const secondJob = second.value[0];
    if (secondJob === undefined) throw new Error("recovery claim must yield a job");
    applyEffect(secondJob.jobId);
    expect(ackJob(store, secondJob.jobId, secondJob.ownerToken, 1050).isOk()).toBe(true);
    const effects = raw.prepare("SELECT COUNT(*) AS n FROM test_effects").get() as { n: number };
    expect(effects.n).toBe(1);
    raw.close();
    store.close();
  });
});
