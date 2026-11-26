import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { SessionRuntime, type ReplaySource } from "@modules/session/runtime";
import { openLineSource } from "@platform/fixture";
import { createStreamOutput } from "@presentation/output";
import { describe, expect, it } from "vitest";

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GatedWritable extends Writable {
  pendingCallbacks: Array<() => void> = [];
  writes = 0;
  maxPending = 0;
  constructor() {
    super({ highWaterMark: 1 });
  }
  override _write(
    _chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes += 1;
    this.pendingCallbacks.push(() => callback());
    this.maxPending = Math.max(this.maxPending, this.pendingCallbacks.length);
  }
  releaseOne(): void {
    this.pendingCallbacks.shift()?.();
  }
}

function countingSource(count: number): ReplaySource & { pulls: () => number } {
  let pulls = 0;
  let index = 0;
  return {
    pulls: () => pulls,
    events: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            pulls += 1;
            if (index >= count) {
              return { done: true, value: undefined };
            }
            const value = {
              sessionId: "s-1",
              streamId: "st-1",
              seq: index,
              kind: "partial",
              utteranceId: `u${index}`,
              revision: 0,
              text: `word ${index}`,
            };
            index += 1;
            return { done: false, value };
          },
        };
      },
    },
    dispose: async (): Promise<void> => undefined,
  };
}

describe("controlled backpressure", () => {
  it("surfaces asynchronous failure even when write returns true", async () => {
    const failing = new Writable({
      highWaterMark: 1_048_576,
      write: (_chunk, _enc, callback) => {
        setTimeout(() => callback(new Error("async failure")), 10);
      },
    });
    const output = createStreamOutput(failing, failing);
    await expect(output.out("hello")).rejects.toThrow("async failure");
  });
  it("stops pulling while the writable is blocked", async () => {
    const gated = new GatedWritable();
    const output = createStreamOutput(gated, gated);
    const source = countingSource(50);
    const runtime = new SessionRuntime();
    const running = runtime.run(source, async (event) => {
      await output.out(JSON.stringify(event));
    });
    await tick(60);
    expect(source.pulls()).toBeLessThanOrEqual(2);
    expect(gated.maxPending).toBeLessThanOrEqual(1);
    for (let i = 0; i < 200; i += 1) {
      gated.releaseOne();
      await tick(1);
    }
    const outcome = await running;
    expect(outcome.isOk()).toBe(true);
  });

  it("negative control: ignoring write backpressure pulls unboundedly", async () => {
    const gated = new GatedWritable();
    const source = countingSource(50);
    const runtime = new SessionRuntime();
    const running = runtime.run(source, (event) => {
      void gated.write(JSON.stringify(event) + "\n");
    });
    await tick(60);
    expect(source.pulls()).toBeGreaterThan(10);
    expect(gated.writableLength).toBeGreaterThan(1000);
    for (let i = 0; i < 200; i += 1) {
      gated.releaseOne();
      await tick(1);
    }
    await running;
  });

  it("rejects on writable error, premature close, and abort during drain", async () => {
    const failing = new Writable({
      highWaterMark: 1,
      write: (_chunk, _enc, callback) => callback(new Error("disk full s3cr3t")),
    });
    await expect(createStreamOutput(failing, failing).out("x".repeat(64))).rejects.toThrow();

    const gated = new GatedWritable();
    const closing = createStreamOutput(gated, gated).out("x".repeat(64));
    gated.destroy();
    await expect(closing).rejects.toThrow();

    const gatedAbort = new GatedWritable();
    const controller = new AbortController();
    const aborting = createStreamOutput(gatedAbort, gatedAbort, controller.signal).out(
      "x".repeat(64),
    );
    controller.abort();
    await expect(aborting).rejects.toMatchObject({ name: "AbortError" });
    expect(gatedAbort.destroyed).toBe(false);
  });
});

async function collectFixture(path: string, maxLineBytes: number): Promise<unknown[]> {
  const opened = await openLineSource(path, { maxLineBytes });
  if (opened.isErr()) {
    throw opened.error;
  }
  const values: unknown[] = [];
  try {
    for await (const value of opened.value.events) {
      values.push(value);
    }
  } finally {
    await opened.value.dispose();
  }
  return values;
}

function tempFixture(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "urbuddy-io-"));
  const path = join(dir, "fixture.ndjson");
  writeFileSync(path, content, "utf8");
  return { dir, path };
}

describe("fixture reader bounds", () => {
  it("enforces byte bounds on multibyte lines", async () => {
    const { dir, path } = tempFixture("é".repeat(40) + "\n");
    try {
      await expect(collectFixture(path, 64)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts excessive whitespace toward the byte bound", async () => {
    const line = " ".repeat(80) + JSON.stringify({ ok: true }) + "\n";
    const { dir, path } = tempFixture(line);
    try {
      await expect(collectFixture(path, 64)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces bounds on unterminated oversized lines", async () => {
    const { dir, path } = tempFixture("é".repeat(40));
    try {
      await expect(collectFixture(path, 64)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without a writer without blocking",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "urbuddy-fifo-"));
      const fifo = join(dir, "in.fifo");
      execFileSync("mkfifo", [fifo]);
      try {
        const opened = await openLineSource(fifo);
        expect(opened.isErr()).toBe(true);
        if (opened.isErr()) {
          expect(opened.error.message).toBe("replay fixture must be a regular file");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    10000,
  );
});
