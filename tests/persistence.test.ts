import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runApp } from "@bootstrap/composition";
import { EXIT_CODES } from "@kernel/exit-codes";
import { EvidenceStore } from "@platform/persistence/store";
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
    ...overrides,
  };
}

function openStore(dir: string, options?: { busyTimeoutMs?: number; maxPageCount?: number }) {
  const opened = EvidenceStore.open(join(dir, "evidence.sqlite"), options);
  if (opened.isErr()) {
    throw new Error(`store must open: ${opened.error.message}`);
  }
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
    expect(store.settings.userVersion).toBe(1);
    expect(store.recordEvent(ev()).isOk()).toBe(true);
    store.close();
    const reopened = openStore(dir);
    expect(reopened.countEvidence()).toBe(1);
    expect(reopened.settings.userVersion).toBe(1);
    reopened.close();
  });

  it("rejects unsupported schema versions", () => {
    const dir = tempDir();
    const path = join(dir, "evidence.sqlite");
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(EvidenceStore.open(path).isErr()).toBe(true);
  });

  it("deduplicates identical events and rejects contradictions", () => {
    const store = openStore(tempDir());
    expect(store.recordEvent(ev())).toMatchObject({ value: "inserted" });
    expect(store.recordEvent(ev())).toMatchObject({ value: "duplicate" });
    expect(store.recordEvent(ev({ text: "changed", contentHash: hash("changed") })).isErr()).toBe(
      true,
    );
    expect(store.countEvidence()).toBe(1);
    store.close();
  });

  it("keeps identical text from different occurrences distinct", () => {
    const store = openStore(tempDir());
    expect(store.recordEvent(ev({ seq: 0, utteranceId: "u1" })).isOk()).toBe(true);
    expect(store.recordEvent(ev({ seq: 1, utteranceId: "u2" })).isOk()).toBe(true);
    expect(store.countEvidence()).toBe(2);
    store.close();
  });

  it("completes operations atomically with one outbox job and idempotent retry", () => {
    const store = openStore(tempDir());
    store.recordEvent(ev());
    const first = store.completeOperation({
      opId: "op-1",
      fingerprint: "fp-1",
      sessionId: "s-1",
      streamId: "st-1",
      summary,
    });
    expect(first).toMatchObject({ value: { status: "committed" } });
    const retry = store.completeOperation({
      opId: "op-1",
      fingerprint: "fp-1",
      sessionId: "s-1",
      streamId: "st-1",
      summary,
    });
    expect(retry).toMatchObject({ value: { status: "existing" } });
    expect(store.countJobs()).toBe(1);
    const conflict = store.completeOperation({
      opId: "op-1",
      fingerprint: "fp-other",
      sessionId: "s-1",
      streamId: "st-1",
      summary,
    });
    expect(conflict.isErr()).toBe(true);
    store.close();
  });

  it("claims exclusively across connections, recovers leases, rejects stale owners", () => {
    const dir = tempDir();
    const a = openStore(dir);
    a.recordEvent(ev());
    a.completeOperation({
      opId: "op-1",
      fingerprint: "fp",
      sessionId: "s-1",
      streamId: "st-1",
      summary,
    });
    const b = openStore(dir);
    const claimA = a.claimJobs({ limit: 1, leaseMs: 1000, nowMs: 1000 });
    const claimB = b.claimJobs({ limit: 1, leaseMs: 1000, nowMs: 1000 });
    expect(claimA.isOk() && claimA.value).toHaveLength(1);
    expect(claimB.isOk() && claimB.value).toHaveLength(0);
    if (!claimA.isOk()) throw new Error("claim must succeed");
    const job = claimA.value[0] as { jobId: string; ownerToken: string };
    const recovered = b.claimJobs({ limit: 1, leaseMs: 1000, nowMs: 3000 });
    expect(recovered.isOk() && recovered.value).toHaveLength(1);
    expect(a.ackJob(job.jobId, job.ownerToken).isErr()).toBe(true);
    if (!recovered.isOk()) throw new Error("recovery claim must succeed");
    const fresh = recovered.value[0] as { jobId: string; ownerToken: string };
    expect(b.ackJob(fresh.jobId, fresh.ownerToken).isOk()).toBe(true);
    expect(b.countJobs("done")).toBe(1);
    a.close();
    b.close();
  });

  it("bounds retries to a terminal failure", () => {
    const store = openStore(tempDir());
    store.recordEvent(ev());
    store.completeOperation({
      opId: "op-1",
      fingerprint: "fp",
      sessionId: "s-1",
      streamId: "st-1",
      summary,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const claim = store.claimJobs({ limit: 1, leaseMs: 1000, nowMs: attempt * 10 });
      if (!claim.isOk() || claim.value.length !== 1) throw new Error("claim must succeed");
      const job = claim.value[0] as { jobId: string; ownerToken: string };
      expect(store.failJob(job.jobId, job.ownerToken).isOk()).toBe(true);
    }
    expect(store.countJobs("failed")).toBe(1);
    const after = store.claimJobs({ limit: 1, leaseMs: 1000, nowMs: 9999 });
    expect(after.isOk() && after.value).toHaveLength(0);
    store.close();
  });

  it("surfaces capacity failure without partial writes beyond committed rows", () => {
    const store = openStore(tempDir(), { maxPageCount: 12 });
    let inserted = 0;
    let failed = false;
    for (let i = 0; i < 200; i += 1) {
      const text = `payload-${i}-` + "x".repeat(500);
      const result = store.recordEvent(
        ev({ seq: i, utteranceId: `u${i}`, text, contentHash: hash(text) }),
      );
      if (result.isOk()) inserted += 1;
      else {
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    expect(store.countEvidence()).toBe(inserted);
    store.close();
  });

  it("observes bounded lock contention outcomes", async () => {
    const dir = tempDir();
    const path = join(dir, "evidence.sqlite");
    const store = openStore(dir, { busyTimeoutMs: 100 });
    const raw = new Database(path);
    raw.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    const blocked = store.recordEvent(ev());
    expect(blocked.isErr()).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    raw.exec("COMMIT");
    raw.close();
    expect(store.recordEvent(ev()).isOk()).toBe(true);
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
    expect(store.countEvidence()).toBe(3);
    expect(store.listEvidence("s-2").map((row) => row.text)).toEqual(["a", "a b", "a b."]);
    expect(store.listGaps("s-2")).toEqual([{ fromSeq: 1, toSeq: 2 }]);
    expect(store.countJobs("pending")).toBe(1);
    store.close();
    expect(await runApp(args, { URBUDDY_DATA_ROOT: dir })).toBe(EXIT_CODES.success);
    const again = openStore(dir);
    expect(again.countEvidence()).toBe(3);
    expect(again.countJobs()).toBe(1);
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
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("no replay output before kill")), 20000);
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (child.pid !== undefined) {
      process.kill(-child.pid, "SIGKILL");
    }
    await new Promise((resolve) => child.once("exit", resolve));
    const afterKill = openStore(dir);
    const partial = afterKill.countEvidence();
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
    expect(recovered.countEvidence()).toBe(4000);
    expect(recovered.countJobs()).toBe(1);
    recovered.close();
  }, 90000);
});
