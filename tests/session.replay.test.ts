import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAppContainer, isAppContainer, runApp } from "@bootstrap/composition";
import { URBUDDY_VERSION } from "@bootstrap/version";
import { fixedClock } from "@kernel/clock";
import { appError, type AppError } from "@kernel/errors";
import { EXIT_CODES } from "@kernel/exit-codes";
import { createDeterministicIdGenerator } from "@kernel/ids";
import { type ReplaySummary, type SessionOutput } from "@modules/session/events";
import { runReplay } from "@modules/session/replay";
import { SessionRuntime, type ReplaySource } from "@modules/session/runtime";
import { openLineSource } from "@platform/fixture";
import { exitCodeForError, runCli, type CliDeps } from "@presentation/cli";
import type { CliOutput } from "@presentation/output";
import { createReplayPort } from "@presentation/replay";
import type { Result } from "neverthrow";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name: string): string => join(root, "fixtures", "replay", name);

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "s-1",
    streamId: "st-1",
    seq: 0,
    kind: "partial",
    utteranceId: "u1",
    revision: 0,
    text: "hello",
    ...overrides,
  };
}

function sourceOf(
  events: unknown[],
  hooks: { disposed?: { called: boolean }; slowMs?: number } = {},
): ReplaySource & { observed: { active: number; maxActive: number } } {
  const observed = { active: 0, maxActive: 0 };
  let index = 0;
  return {
    observed,
    events: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (index >= events.length) {
              return { done: true, value: undefined };
            }
            observed.active += 1;
            observed.maxActive = Math.max(observed.maxActive, observed.active);
            try {
              if (hooks.slowMs !== undefined) {
                await new Promise((resolve) => setTimeout(resolve, hooks.slowMs));
              }
              const value = events[index];
              index += 1;
              return { done: false, value };
            } finally {
              observed.active -= 1;
            }
          },
        };
      },
    },
    dispose: async (): Promise<void> => {
      if (hooks.disposed !== undefined) {
        hooks.disposed.called = true;
      }
    },
  };
}

async function collect(
  source: ReplaySource,
  options?: {
    signal?: AbortSignal;
    maxUtterances?: number;
    maxTextBytes?: number;
    maxIdBytes?: number;
    slowSinkMs?: number;
  },
): Promise<{ outputs: SessionOutput[]; outcome: Result<ReplaySummary, AppError> }> {
  const outputs: SessionOutput[] = [];
  const runtime = new SessionRuntime();
  const outcome = await runtime.run(
    source,
    async (output) => {
      if (options?.slowSinkMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.slowSinkMs));
      }
      outputs.push(output);
    },
    {
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.maxUtterances === undefined ? {} : { maxUtterances: options.maxUtterances }),
      ...(options?.maxTextBytes === undefined ? {} : { maxTextBytes: options.maxTextBytes }),
      ...(options?.maxIdBytes === undefined ? {} : { maxIdBytes: options.maxIdBytes }),
    },
  );
  return { outputs, outcome };
}

function summaryOf(outputs: SessionOutput[]): SessionOutput {
  const last = outputs[outputs.length - 1];
  if (last === undefined || last.type !== "completed") {
    throw new Error("expected a completed summary");
  }
  return last;
}

describe("session replay semantics", () => {
  it("applies rising revisions and finals in order", async () => {
    const source = sourceOf([
      event({ seq: 0, revision: 0, text: "hello" }),
      event({ seq: 1, revision: 1, text: "hello there" }),
      event({ seq: 2, kind: "final", revision: 2, text: "hello there." }),
    ]);
    const { outputs, outcome } = await collect(source);
    expect(outcome.isOk()).toBe(true);
    const summary = summaryOf(outputs);
    expect(summary).toMatchObject({
      type: "completed",
      summary: { applied: 3, duplicates: 0, stale: 0, gaps: 0, missing: 0 },
    });
    expect(outputs.filter((o) => o.type === "applied")).toHaveLength(3);
  });

  it("rejects malformed events without applying them", async () => {
    const source = sourceOf([event({ seq: 0 }), { ...event({ seq: 1 }), text: 42 }]);
    const { outputs, outcome } = await collect(source);
    expect(outputs.filter((o) => o.type === "applied")).toHaveLength(1);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects contradictory text for the same utterance revision", async () => {
    const source = sourceOf([
      event({ seq: 0, revision: 0, text: "hello" }),
      event({ seq: 1, revision: 0, text: "goodbye" }),
    ]);
    const { outcome } = await collect(source);
    expect(outcome.isErr()).toBe(true);
  });

  it("counts exact repeats as duplicates without re-applying", async () => {
    const source = sourceOf([
      event({ seq: 0, revision: 1, text: "hello there" }),
      event({ seq: 1, revision: 1, text: "hello there" }),
    ]);
    const { outputs } = await collect(source);
    const summary = summaryOf(outputs);
    expect(summary).toMatchObject({
      summary: { applied: 1, duplicates: 1, stale: 0 },
    });
  });

  it("rejects superseded revisions as stale", async () => {
    const source = sourceOf([
      event({ seq: 0, revision: 1, text: "hello there" }),
      event({ seq: 1, revision: 0, text: "hello" }),
    ]);
    const { outputs } = await collect(source);
    expect(outputs[outputs.length - 2]).toMatchObject({
      type: "stale",
      reason: "superseded",
    });
    expect(summaryOf(outputs)).toMatchObject({ summary: { applied: 1, stale: 1 } });
  });

  it("treats revisions after a final as stale", async () => {
    const source = sourceOf([
      event({ seq: 0, kind: "final", revision: 1, text: "done." }),
      event({ seq: 1, revision: 2, text: "done now." }),
    ]);
    const { outputs } = await collect(source);
    expect(outputs[outputs.length - 2]).toMatchObject({
      type: "stale",
      reason: "finalized",
    });
  });

  it("reports sequence gaps and rejects late arrivals as stale", async () => {
    const source = sourceOf([
      event({ seq: 0, utteranceId: "u1", revision: 0, text: "a" }),
      event({ seq: 2, utteranceId: "u1", revision: 1, text: "a b" }),
      event({ seq: 1, utteranceId: "u2", revision: 0, text: "x" }),
    ]);
    const { outputs } = await collect(source);
    expect(outputs).toContainEqual({ type: "gap", from: 1, to: 2 });
    expect(outputs[outputs.length - 2]).toMatchObject({ type: "stale", reason: "superseded" });
    expect(summaryOf(outputs)).toMatchObject({
      summary: { applied: 2, stale: 1, gaps: 1, missing: 1 },
    });
  });

  it("rejects events from another session or stream", async () => {
    const source = sourceOf([
      event({ seq: 0, sessionId: "s-1" }),
      event({ seq: 1, sessionId: "s-2" }),
    ]);
    const { outcome } = await collect(source);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects an empty source instead of inventing an identity", async () => {
    const { outcome } = await collect(sourceOf([]));
    expect(outcome.isErr()).toBe(true);
  });

  it("fails closed when the utterance bound is exceeded", async () => {
    const source = sourceOf([
      event({ seq: 0, utteranceId: "u1" }),
      event({ seq: 1, utteranceId: "u2" }),
      event({ seq: 2, utteranceId: "u3" }),
    ]);
    const { outcome } = await collect(source, { maxUtterances: 2 });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("pulls one event at a time under a slow consumer", async () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      event({ seq: i, utteranceId: `u${i}`, revision: 0, text: `word ${i}` }),
    );
    const source = sourceOf(events);
    const { outputs } = await collect(source, { slowSinkMs: 2 });
    expect(source.observed.maxActive).toBeLessThanOrEqual(1);
    expect(summaryOf(outputs)).toMatchObject({ summary: { applied: 20 } });
    const appliedSeqs = outputs
      .filter((o) => o.type === "applied")
      .map((o) => (o as { seq: number }).seq);
    expect(appliedSeqs).toEqual(events.map((_, i) => i));
  });

  it("cancels mid-run, releases the source, and reports CANCELLED", async () => {
    const disposed = { called: false };
    const events = Array.from({ length: 50 }, (_, i) =>
      event({ seq: i, utteranceId: `u${i}`, revision: 0, text: `word ${i}` }),
    );
    const source = sourceOf(events, { disposed });
    const controller = new AbortController();
    const outputs: SessionOutput[] = [];
    const runtime = new SessionRuntime();
    const outcome = await runtime.run(
      source,
      async (output) => {
        outputs.push(output);
        if (outputs.filter((o) => o.type === "applied").length === 5) {
          controller.abort();
        }
      },
      { signal: controller.signal },
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("CANCELLED");
    }
    expect(disposed.called).toBe(true);
    expect(outputs.filter((o) => o.type === "applied")).toHaveLength(5);
  });

  it("refuses to start on an already-aborted signal and still releases the source", async () => {
    const disposed = { called: false };
    const source = sourceOf([event({ seq: 0 })], { disposed });
    const controller = new AbortController();
    controller.abort();
    const { outputs, outcome } = await collect(source, { signal: controller.signal });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("CANCELLED");
    }
    expect(outputs).toHaveLength(0);
    expect(disposed.called).toBe(true);
  });

  it("normalizes sink failures without leaking messages", async () => {
    const source = sourceOf([event({ seq: 0 })]);
    const runtime = new SessionRuntime();
    const outcome = await runtime.run(source, () => {
      throw new Error("token=s3cr3t-sink");
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("INTERNAL");
      expect(outcome.error.message).not.toContain("s3cr3t");
    }
  });

  it("surfaces source failures and still releases the source", async () => {
    const disposed = { called: false };
    const source: ReplaySource = {
      events: {
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<unknown>> => {
              throw appError("INTERNAL", "disk gone");
            },
          };
        },
      },
      dispose: async (): Promise<void> => {
        disposed.called = true;
      },
    };
    const { outcome } = await collect(source);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("INTERNAL");
      expect(outcome.error.message).toBe("disk gone");
    }
    expect(disposed.called).toBe(true);
  });

  it("keeps independent sessions isolated and repeats deterministically", async () => {
    const first = sourceOf([event({ seq: 0, sessionId: "a", streamId: "x", utteranceId: "u1" })]);
    const second = sourceOf([event({ seq: 0, sessionId: "b", streamId: "y", utteranceId: "u1" })]);
    const again = sourceOf([event({ seq: 0, sessionId: "a", streamId: "x", utteranceId: "u1" })]);
    const one = await collect(first);
    const two = await collect(second);
    const repeat = await collect(again);
    expect(one.outputs).toEqual(repeat.outputs);
    expect(one.outputs).not.toEqual(two.outputs);
  });
});

function testDeps(signal?: AbortSignal): CliDeps {
  const created = createAppContainer({
    env: {},
    ids: createDeterministicIdGenerator("cli"),
    clock: fixedClock(0),
  });
  if (!isAppContainer(created)) {
    throw new Error("fixture container must build");
  }
  return {
    version: URBUDDY_VERSION,
    config: created.config,
    paths: created.paths,
    sessionId: created.sessionId,
    correlationId: created.correlationId,
    nowIso: created.clock.isoNow(),
    signal: signal ?? new AbortController().signal,
    replayPort: createReplayPort({
      runOperation: runReplay,
      openSource: (fixture, sourceSignal) => openLineSource(fixture, { signal: sourceSignal }),
    }),
  };
}

function capture(): { lines: string[]; output: CliOutput } {
  const lines: string[] = [];
  return {
    lines,
    output: {
      out: (line: string) => {
        lines.push(line);
      },
      errLine: () => undefined,
    },
  };
}

describe("replay command", () => {
  it("replays a fixture file with a final summary", async () => {
    const captured = capture();
    const code = await runCli(
      ["node", "urbuddy", "replay", fixture("basic.ndjson")],
      testDeps(),
      captured.output,
    );
    expect(code).toBe(EXIT_CODES.success);
    expect(captured.lines.at(-1)).toBe(
      "replay complete: applied=5 duplicates=0 stale=0 gaps=0 missing=0",
    );
  });

  it("emits stable JSON lines with --json", async () => {
    const captured = capture();
    const code = await runCli(
      ["node", "urbuddy", "replay", fixture("basic.ndjson"), "--json"],
      testDeps(),
      captured.output,
    );
    expect(code).toBe(EXIT_CODES.success);
    const parsed = captured.lines.map((line) => JSON.parse(line) as { type: string });
    expect(parsed.at(-1)).toMatchObject({ type: "completed" });
    expect(parsed).toHaveLength(6);
  });

  it("reports gaps from a fixture file", async () => {
    const captured = capture();
    const code = await runCli(
      ["node", "urbuddy", "replay", fixture("gaps.ndjson")],
      testDeps(),
      captured.output,
    );
    expect(code).toBe(EXIT_CODES.success);
    expect(captured.lines).toContain("[gap] missing seq 1..1");
    expect(captured.lines.at(-1)).toBe(
      "replay complete: applied=3 duplicates=1 stale=3 gaps=1 missing=1",
    );
  });

  it("serves replay end to end with a success exit code", async () => {
    expect(await runApp(["node", "urbuddy", "replay", fixture("basic.ndjson")], {})).toBe(
      EXIT_CODES.success,
    );
  });

  it("rejects malformed fixtures with a usage error", async () => {
    expect(await runApp(["node", "urbuddy", "replay", fixture("malformed.ndjson")], {})).toBe(
      EXIT_CODES.usage,
    );
  });

  it("rejects missing fixtures with a validation error", async () => {
    const captured = capture();
    await expect(
      runCli(
        ["node", "urbuddy", "replay", join(root, "fixtures", "replay", "absent.ndjson")],
        testDeps(),
        captured.output,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("replays a generated fixture deterministically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "urbuddy-replay-"));
    const path = join(dir, "shot.ndjson");
    const lines = Array.from(
      { length: 30 },
      (_, i) =>
        JSON.stringify(
          event({
            seq: i,
            utteranceId: `u${i % 5}`,
            revision: Math.floor(i / 5),
            text: `take ${i}`,
          }),
        ) + "\n",
    );
    writeFileSync(path, lines.join(""), "utf8");
    const first = capture();
    const second = capture();
    await runCli(["node", "urbuddy", "replay", path], testDeps(), first.output);
    await runCli(["node", "urbuddy", "replay", path], testDeps(), second.output);
    expect(first.lines).toEqual(second.lines);
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(30);
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps a pre-aborted replay to the cancelled error", async () => {
    const controller = new AbortController();
    controller.abort();
    const captured = capture();
    await expect(
      runCli(
        ["node", "urbuddy", "replay", fixture("basic.ndjson")],
        testDeps(controller.signal),
        captured.output,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(exitCodeForError(appError("CANCELLED", "x"))).toBe(EXIT_CODES.cancelled);
  });

  it("emits one compact JSON object per physical line", async () => {
    const captured = capture();
    await runCli(
      ["node", "urbuddy", "replay", fixture("gaps.ndjson"), "--json"],
      testDeps(),
      captured.output,
    );
    for (const line of captured.lines) {
      expect(line.startsWith("{")).toBe(true);
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });
});

describe("review regressions", () => {
  it("applies same-text partial-to-final transition and finalizes", async () => {
    const source = sourceOf([
      event({ seq: 0, revision: 0, text: "hello" }),
      event({ seq: 1, kind: "final", revision: 0, text: "hello" }),
      event({ seq: 2, revision: 1, text: "hello again" }),
    ]);
    const { outputs } = await collect(source);
    expect(outputs.filter((o) => o.type === "applied")).toHaveLength(2);
    expect(outputs[outputs.length - 2]).toMatchObject({ type: "stale", reason: "finalized" });
    expect(summaryOf(outputs)).toMatchObject({ summary: { applied: 2, duplicates: 0, stale: 1 } });
  });

  it("classifies identical final retransmission as duplicate, contradictory as error", async () => {
    const dup = await collect(
      sourceOf([
        event({ seq: 0, kind: "final", revision: 1, text: "done." }),
        event({ seq: 1, kind: "final", revision: 1, text: "done." }),
      ]),
    );
    expect(summaryOf(dup.outputs)).toMatchObject({
      summary: { applied: 1, duplicates: 1, stale: 0 },
    });
    const contra = await collect(
      sourceOf([
        event({ seq: 0, kind: "final", revision: 1, text: "done." }),
        event({ seq: 1, kind: "final", revision: 1, text: "changed." }),
      ]),
    );
    expect(contra.outcome.isErr()).toBe(true);
    if (contra.outcome.isErr()) {
      expect(contra.outcome.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects conflicting reuse of the same sequence", async () => {
    const { outcome } = await collect(
      sourceOf([
        event({ seq: 0, utteranceId: "u1", text: "a" }),
        event({ seq: 0, utteranceId: "u2", text: "x" }),
      ]),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("does not collide distinct events through delimiter injection", async () => {
    const { outcome } = await collect(
      sourceOf([
        event({ seq: 0, utteranceId: "p|5|final|q", kind: "final", revision: 5, text: "r" }),
        event({ seq: 0, utteranceId: "p", kind: "final", revision: 5, text: "q|5|final|r" }),
      ]),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("counts exact sequence retransmission as duplicate", async () => {
    const { outputs } = await collect(sourceOf([event({ seq: 0 }), event({ seq: 0 })]));
    expect(summaryOf(outputs)).toMatchObject({ summary: { applied: 1, duplicates: 1 } });
  });

  it("enforces byte bounds on text and identifiers", async () => {
    const okRun = await collect(sourceOf([event({ text: "éé" })]), { maxTextBytes: 4 });
    expect(okRun.outcome.isOk()).toBe(true);
    const overText = await collect(sourceOf([event({ text: "ééé" })]), { maxTextBytes: 4 });
    expect(overText.outcome.isErr()).toBe(true);
    const overId = await collect(sourceOf([event({ utteranceId: "ééé" })]), { maxIdBytes: 4 });
    expect(overId.outcome.isErr()).toBe(true);
  });

  it("rejects invalid resource limit options", async () => {
    const { outcome } = await collect(sourceOf([event({})]), { maxUtterances: 0 });
    expect(outcome.isErr()).toBe(true);
  });

  it("preserves the primary failure when disposal also fails", async () => {
    const source: ReplaySource = {
      events: {
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<unknown>> => {
              throw appError("INTERNAL", "disk gone");
            },
          };
        },
      },
      dispose: async (): Promise<void> => {
        throw new Error("cleanup boom");
      },
    };
    const { outcome } = await collect(source);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.message).toBe("disk gone");
      expect(outcome.error.details).toEqual({ cleanup: "INTERNAL" });
    }
  });

  it("reports cleanup failure after an otherwise successful run", async () => {
    const inner = sourceOf([event({})]);
    const source: ReplaySource = {
      events: inner.events,
      dispose: async (): Promise<void> => {
        throw new Error("cleanup boom s3cr3t");
      },
    };
    const { outcome } = await collect(source);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.message).toBe("replay cleanup failed");
      expect(outcome.error.message).not.toContain("s3cr3t");
    }
  });

  it("does not complete when cancellation lands during disposal", async () => {
    const controller = new AbortController();
    const inner = sourceOf([event({ seq: 0 })]);
    const source: ReplaySource = {
      events: inner.events,
      dispose: async (): Promise<void> => {
        controller.abort();
      },
    };
    const outputs: SessionOutput[] = [];
    const runtime = new SessionRuntime();
    const outcome = await runtime.run(
      source,
      (output) => {
        outputs.push(output);
      },
      { signal: controller.signal },
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("CANCELLED");
    }
    expect(outputs.some((o) => o.type === "completed")).toBe(false);
  });

  it("does not complete when cancellation lands at the end boundary", async () => {
    const controller = new AbortController();
    const source = sourceOf([event({ seq: 0 })]);
    const outputs: SessionOutput[] = [];
    const runtime = new SessionRuntime();
    const outcome = await runtime.run(
      source,
      (output) => {
        outputs.push(output);
        controller.abort();
      },
      { signal: controller.signal },
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("CANCELLED");
    }
    expect(outputs.some((o) => o.type === "completed")).toBe(false);
  });

  it("isolates concurrent sessions", async () => {
    const make = (session: string) =>
      sourceOf(
        Array.from({ length: 8 }, (_, i) =>
          event({ sessionId: session, seq: i, utteranceId: `u${i}`, text: `${session}-${i}` }),
        ),
      );
    const [a, b] = await Promise.all([
      collect(make("a"), { slowSinkMs: 2 }),
      collect(make("b"), { slowSinkMs: 1 }),
    ]);
    expect(summaryOf(a.outputs)).toMatchObject({ summary: { sessionId: "a", applied: 8 } });
    expect(summaryOf(b.outputs)).toMatchObject({ summary: { sessionId: "b", applied: 8 } });
  });

  it("rejects non-regular fixture inputs and hides raw paths", async () => {
    const opened = await openLineSource(join(root, "fixtures"));
    expect(opened.isErr()).toBe(true);
    const missing = await openLineSource(join(root, "fixtures", "replay", "absent.ndjson"));
    expect(missing.isErr()).toBe(true);
    if (missing.isErr()) {
      expect(missing.error.message).not.toContain("absent");
      expect(JSON.stringify(missing.error)).not.toContain("absent");
    }
  });

  it("closes the file source idempotently", async () => {
    const opened = await openLineSource(fixture("basic.ndjson"));
    expect(opened.isOk()).toBe(true);
    if (opened.isOk()) {
      await opened.value.dispose();
      await opened.value.dispose();
    }
  });

  it("reports the correct malformed JSON line number", async () => {
    const captured = capture();
    await expect(
      runCli(
        ["node", "urbuddy", "replay", fixture("malformed.ndjson")],
        testDeps(),
        captured.output,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const port = testDeps().replayPort;
    if (port === undefined) {
      throw new Error("replay port must be wired in tests");
    }
    const viaPort = await port({
      fixture: fixture("malformed.ndjson"),
      json: false,
      signal: new AbortController().signal,
      output: capture().output,
    });
    expect(viaPort.isErr()).toBe(true);
    if (viaPort.isErr()) {
      expect(viaPort.error.message).toBe("replay fixture line 2 is not valid JSON");
    }
  });
});
