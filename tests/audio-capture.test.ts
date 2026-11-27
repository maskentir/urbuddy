import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ChildCaptureSource,
  parseStageLine,
  resolveBundledHelperPath,
  resolveHelperPath,
  spawnAudioSource,
} from "@adapters/audio/capture-source";
import { createAppContainer, isAppContainer } from "@bootstrap/composition";
import { fixedClock, systemClock } from "@kernel/clock";
import { appError, type AppError } from "@kernel/errors";
import {
  runCaptureSession,
  type CaptureGap,
  type CaptureSource,
  type SourceItem,
} from "@modules/perception/audio";
import { createCapturePort } from "@presentation/capture";
import { createProgram } from "@presentation/cli";
import type { CliOutput } from "@presentation/output";
import { err, ok, type Result } from "neverthrow";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function writeSineFixture(path: string, seconds = 5, frequency = 440, sampleRate = 48000): void {
  const frames = seconds * sampleRate;
  const data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + frames * 2, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(
      Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)),
      44 + i * 2,
    );
  }
  writeFileSync(path, data);
}
const floodScript = join(here, "support", "audio-frame-flood.mjs");
const ignoreSigtermScript = join(here, "support", "audio-ignore-sigterm.mjs");
const truncatedTailScript = join(here, "support", "audio-truncated-tail.mjs");
const abruptEndScript = join(here, "support", "audio-abrupt-end.mjs");
const endThenHangScript = join(here, "support", "audio-end-then-hang.mjs");
const endlessIgnoreScript = join(here, "support", "audio-endless-ignore.mjs");
const signalDeathScript = join(here, "support", "audio-signal-death.mjs");

function formatItem(): SourceItem {
  return { type: "format", seq: 0, format: { sampleRate: 48000, channels: 1 } };
}

function audioItem(seq: number, startSample: number, samples: number[]): SourceItem {
  return { type: "audio", chunk: { seq, startSample, samples: new Float32Array(samples) } };
}

function endItem(seq: number, sourceFrames: number, delivered: number): SourceItem {
  return {
    type: "end",
    seq,
    end: { captured: 2, delivered, dropped: 0, reason: "completed", sourceFrames },
  };
}

interface Controllable {
  readonly source: CaptureSource;
  push(item: SourceItem): void;
  finish(): void;
  stopSeen(): boolean;
  setDisposeError(error: AppError | undefined): void;
}

function controllable(): Controllable {
  const queue: SourceItem[] = [];
  let closed = false;
  let stopped = false;
  let audioSeen = 0;
  let samplesSeen = 0;
  let disposeError: AppError | undefined;
  let notified: (() => void) | undefined;
  const wake = (): void => {
    notified?.();
    notified = undefined;
  };
  return {
    source: {
      async *items(signal: AbortSignal): AsyncIterable<SourceItem> {
        while (true) {
          if (signal.aborted) {
            throw appError("CANCELLED", "capture cancelled");
          }
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) {
            return;
          }
          await new Promise<void>((resolve) => {
            notified = resolve;
          });
        }
      },
      async stop(): Promise<void> {
        stopped = true;
        queue.push(endItem(audioSeen + 1, samplesSeen, audioSeen));
        closed = true;
        wake();
      },
      async dispose(): Promise<Result<void, AppError>> {
        if (disposeError !== undefined) {
          return err(disposeError);
        }
        return ok(undefined);
      },
    },
    push: (item: SourceItem): void => {
      if (item.type === "audio") {
        audioSeen += 1;
        samplesSeen += item.chunk.samples.length;
      }
      queue.push(item);
      wake();
    },
    finish: (): void => {
      closed = true;
      wake();
    },
    stopSeen: (): boolean => stopped,
    setDisposeError: (error: AppError | undefined): void => {
      disposeError = error;
    },
  };
}

function sourceFrom(items: SourceItem[]): CaptureSource {
  const held = controllable();
  for (const item of items) {
    held.push(item);
  }
  held.finish();
  return held.source;
}

function testOutput(): { output: CliOutput; lines: string[] } {
  const lines: string[] = [];
  return {
    output: {
      out: (line: string) => {
        lines.push(line);
      },
      errLine: () => {},
    },
    lines,
  };
}

describe("capture orchestration", () => {
  it("accounts frames, levels, and helper counters on a clean run", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([
        formatItem(),
        audioItem(1, 0, [0.5, -0.5, 0, 0]),
        audioItem(2, 4, [0.25, 0.25, 0.25, 0.25]),
        endItem(3, 8, 2),
      ]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isOk()).toBe(true);
    if (outcome.isErr()) {
      throw new Error("clean capture must succeed");
    }
    const summary = outcome.value;
    expect(summary.receivedFrames).toBe(2);
    expect(summary.receivedSamples).toBe(8);
    expect(summary.gaps).toBe(0);
    expect(summary.rms).toBeCloseTo(Math.sqrt(0.75 / 8), 5);
    expect(summary.peak).toBeCloseTo(0.5, 5);
    expect(summary.signalPresent).toBe(true);
    expect(summary.helperDelivered).toBe(2);
    expect(summary.endReason).toBe("completed");
  });

  it("records an explicit gap when samples go missing", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([
        formatItem(),
        audioItem(1, 0, [0.5, 0.5]),
        audioItem(2, 8, [0.5, 0.5]),
        endItem(3, 10, 2),
      ]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isOk()).toBe(true);
    if (outcome.isErr()) {
      throw new Error("gapped capture must complete");
    }
    expect(outcome.value.gaps).toBe(1);
    const gapRanges: readonly CaptureGap[] = outcome.value.gapRanges;
    expect(gapRanges).toEqual([{ fromSample: 2, toSample: 8 }]);
  });

  it("reports trailing loss detected at the end acknowledgement", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([formatItem(), audioItem(1, 0, [0.5, 0.5]), endItem(2, 5, 1)]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isOk()).toBe(true);
    if (outcome.isErr()) {
      throw new Error("trailing loss must complete with a gap");
    }
    expect(outcome.value.gaps).toBe(1);
    expect(outcome.value.gapRanges).toEqual([{ fromSample: 2, toSample: 5 }]);
  });

  it("rejects a delivery count that contradicts received audio", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([formatItem(), audioItem(1, 0, [0.5]), endItem(2, 1, 9)]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("rejects a source clock that contradicts received audio", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([formatItem(), audioItem(1, 0, [0.5, 0.5]), endItem(2, 1, 1)]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("fails closed on overlapping audio", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([
        formatItem(),
        audioItem(1, 0, [0.5, 0.5]),
        audioItem(2, 1, [0.5, 0.5]),
        endItem(3, 4, 2),
      ]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("overlapping audio must fail");
    }
    expect(outcome.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a skipped chunk sequence", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([
        formatItem(),
        audioItem(1, 0, [0.5]),
        audioItem(3, 1, [0.5]),
        endItem(4, 2, 2),
      ]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("rejects an end frame that breaks sequence continuity", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([formatItem(), audioItem(1, 0, [0.5]), endItem(9, 1, 1)]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("rejects audio before its format", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([audioItem(1, 0, [0.5]), endItem(2, 1, 1)]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("rejects a second format frame", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([formatItem(), formatItem()]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("rejects a stream that ends without helper acknowledgement", async () => {
    const held = controllable();
    held.push(formatItem());
    held.push(audioItem(1, 0, [0.5]));
    held.finish();
    const outcome = await runCaptureSession({
      source: held.source,
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("reports cancellation instead of success", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runCaptureSession({
      source: sourceFrom([formatItem()]),
      signal: controller.signal,
      clock: fixedClock(0),
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("aborted capture must not succeed");
    }
    expect(outcome.error.code).toBe("CANCELLED");
  });

  it("surfaces cleanup failure after a successful capture", async () => {
    const held = controllable();
    held.push(formatItem());
    held.push(audioItem(1, 0, [0]));
    held.push(endItem(2, 1, 1));
    held.finish();
    held.setDisposeError(appError("RESOURCE_RELEASE_FAILED", "cleanup failed"));
    const outcome = await runCaptureSession({
      source: held.source,
      signal: new AbortController().signal,
      clock: fixedClock(0),
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("cleanup failure must surface");
    }
    expect(outcome.error.code).toBe("RESOURCE_RELEASE_FAILED");
  });

  it("validates the duration bound before starting", async () => {
    const outcome = await runCaptureSession({
      source: sourceFrom([]),
      signal: new AbortController().signal,
      clock: fixedClock(0),
      durationMs: 500,
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("emits stats no faster than once per second", async () => {
    const clock = fixedClock(0);
    const stats: number[] = [];
    const held = controllable();
    held.push(formatItem());
    const outcomePromise = runCaptureSession({
      source: held.source,
      signal: new AbortController().signal,
      clock,
      onStats: async (stat) => {
        stats.push(stat.receivedFrames);
      },
    });
    held.push(audioItem(1, 0, [0.5]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stats).toHaveLength(0);
    clock.advance(1500);
    held.push(audioItem(2, 1, [0.5]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stats).toHaveLength(1);
    held.push(endItem(3, 2, 2));
    held.finish();
    const outcome = await outcomePromise;
    expect(outcome.isOk()).toBe(true);
  });

  it("stops gracefully when the duration elapses", async () => {
    const held = controllable();
    held.push(formatItem());
    const outcome = await runCaptureSession({
      source: held.source,
      signal: new AbortController().signal,
      clock: fixedClock(0),
      durationMs: 1000,
    });
    expect(held.stopSeen()).toBe(true);
    expect(outcome.isOk()).toBe(true);
    if (outcome.isErr()) {
      throw new Error("deadline stop must complete");
    }
    expect(outcome.value.endReason).toBe("completed");
  }, 10000);
});

describe("capture source validation", () => {
  it("refuses real capture off macOS", () => {
    const outcome = spawnAudioSource({ helperPath: "/bin/true", platformName: "linux" });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("linux capture must be refused");
    }
    expect(outcome.error.code).toBe("UNSUPPORTED");
  });

  it("refuses a missing helper binary", () => {
    const outcome = spawnAudioSource({
      helperPath: "/nonexistent/urbuddy-audio-capture",
      platformName: "linux",
      syntheticFrames: 1,
    });
    expect(outcome.isErr()).toBe(true);
  });

  it("bounds synthetic frame counts and buffer sizes", () => {
    for (const syntheticFrames of [-1, 100_001]) {
      const outcome = spawnAudioSource({
        helperPath: "/bin/true",
        platformName: "linux",
        syntheticFrames,
      });
      expect(outcome.isErr()).toBe(true);
    }
    const bounded = spawnAudioSource({
      helperPath: "/bin/true",
      platformName: "linux",
      syntheticFrames: 1,
      maxBufferedBytes: 1024,
    });
    expect(bounded.isErr()).toBe(true);
  });

  it("rejects a relative helper override", () => {
    const outcome = resolveHelperPath({ URBUDDY_AUDIO_HELPER: "relative/path" }, "file:///x/y.mjs");
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("relative override must fail");
    }
    expect(outcome.error.code).toBe("VALIDATION_FAILED");
  });

  it("resolves a helper from a directory tree without touching its messages", () => {
    const root = join(tmpdir(), `urbuddy-resolve-${Date.now()}`);
    const bin = join(root, "pkg", "native", "audio-capture-macos", "bin");
    mkdirSync(bin, { recursive: true });
    const helper = join(bin, "urbuddy-audio-capture");
    writeFileSync(helper, "#!/bin/sh\nexit 0\n");
    chmodSync(helper, 0o755);
    const found = resolveHelperPath({}, `file://${join(root, "pkg", "dist", "x.mjs")}`);
    expect(found.isOk()).toBe(true);
    if (found.isErr()) {
      throw new Error("bundled helper must resolve");
    }
    expect(found.value).toBe(helper);
    chmodSync(helper, 0o644);
    const denied = resolveHelperPath({}, `file://${join(root, "pkg", "dist", "x.mjs")}`);
    expect(denied.isErr()).toBe(true);
  });

  it("only trusts known helper stages", () => {
    expect(parseStageLine('{"state":"error","stage":"start"}')).toBe("start");
    expect(parseStageLine('{"state":"error","stage":"rm -rf /"}')).toBeUndefined();
    expect(parseStageLine("not json")).toBeUndefined();
  });
});

describe("capture presentation", () => {
  function cliProgram(deps: {
    capturePort?: ReturnType<typeof createCapturePort>;
  }): ReturnType<typeof createProgram> {
    const created = createAppContainer({ env: {} });
    if (!isAppContainer(created)) {
      throw new Error("container must build");
    }
    return createProgram({
      version: "test",
      config: created.config,
      paths: created.paths,
      sessionId: created.sessionId,
      correlationId: created.correlationId,
      nowIso: created.clock.isoNow(),
      signal: new AbortController().signal,
      ...(deps.capturePort === undefined ? {} : { capturePort: deps.capturePort }),
    });
  }

  it("refuses capture without child-process authorization", async () => {
    const program = cliProgram({
      capturePort: createCapturePort({ runSession: runCaptureSession, clock: fixedClock(0) }),
    });
    await expect(program.parseAsync(["node", "urbuddy", "capture"])).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("rejects an out-of-range duration with a usage error", async () => {
    const program = cliProgram({
      capturePort: createCapturePort({ runSession: runCaptureSession, clock: fixedClock(0) }),
    });
    await expect(
      program.parseAsync(["node", "urbuddy", "capture", "--duration", "0"]),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects non-numeric durations instead of coercing them", async () => {
    const program = cliProgram({
      capturePort: createCapturePort({ runSession: runCaptureSession, clock: fixedClock(0) }),
    });
    await expect(
      program.parseAsync(["node", "urbuddy", "capture", "--duration", "10abc"]),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      program.parseAsync(["node", "urbuddy", "capture", "--synthetic-frames", "2x"]),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("reports a silent capture honestly", async () => {
    const { output, lines } = testOutput();
    const port = createCapturePort({
      runSession: async () =>
        ok({
          format: { sampleRate: 48000, channels: 2 },
          receivedFrames: 10,
          receivedSamples: 20,
          droppedHelper: 0,
          gaps: 0,
          gapRanges: [],
          helperCaptured: 10,
          helperDelivered: 10,
          rms: 0,
          peak: 0,
          elapsedMs: 1000,
          signalPresent: false,
          endReason: "completed",
        }),
      clock: fixedClock(0),
      spawnSource: () => ok(sourceFrom([formatItem()])),
      resolveHelper: () => ok("/fake/helper"),
    });
    const outcome = await port({
      json: false,
      signal: new AbortController().signal,
      output,
    });
    expect(outcome.isOk()).toBe(true);
    expect(lines.some((line) => line.includes("signal=none"))).toBe(true);
    expect(lines.some((line) => line.includes("indistinguishable from digital silence"))).toBe(
      true,
    );
  });

  it("emits one compact JSON object per line in json mode", async () => {
    const { output, lines } = testOutput();
    const port = createCapturePort({
      runSession: async () =>
        ok({
          format: { sampleRate: 48000, channels: 2 },
          receivedFrames: 1,
          receivedSamples: 4,
          droppedHelper: 0,
          gaps: 0,
          gapRanges: [],
          helperCaptured: 1,
          helperDelivered: 1,
          rms: 0.25,
          peak: 0.5,
          elapsedMs: 1200,
          signalPresent: true,
          endReason: "completed",
        }),
      clock: fixedClock(0),
      spawnSource: () => ok(sourceFrom([formatItem()])),
      resolveHelper: () => ok("/fake/helper"),
    });
    const outcome = await port({
      json: true,
      signal: new AbortController().signal,
      output,
    });
    expect(outcome.isOk()).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

const helperAvailable = process.platform === "darwin" && resolveBundledHelperPath({}).isOk();

describe.runIf(helperAvailable)("native helper integration", () => {
  it("captures synthetic frames through the real helper binary", async () => {
    const resolved = resolveBundledHelperPath({});
    if (resolved.isErr()) {
      throw new Error("helper must resolve on this machine");
    }
    const spawned = spawnAudioSource({ helperPath: resolved.value, syntheticFrames: 3 });
    if (spawned.isErr()) {
      throw new Error("synthetic spawn must succeed");
    }
    const outcome = await runCaptureSession({
      source: spawned.value,
      signal: new AbortController().signal,
      clock: fixedClock(0),
      durationMs: 30000,
    });
    expect(outcome.isOk()).toBe(true);
    if (outcome.isErr()) {
      throw new Error("synthetic capture must succeed");
    }
    expect(outcome.value.receivedFrames).toBe(3);
    expect(outcome.value.format).toEqual({ sampleRate: 48000, channels: 2 });
    expect(outcome.value.rms).toBeCloseTo(0.3536, 2);
    expect(outcome.value.signalPresent).toBe(true);
  });

  it("terminates a runaway capture when the output consumer stalls", async () => {
    const resolved = resolveBundledHelperPath({});
    if (resolved.isErr()) {
      throw new Error("helper must resolve on this machine");
    }
    const child = spawn(
      resolved.value,
      ["--chunk-frames", "2048", "--synthetic-frames", "100000"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const source = new ChildCaptureSource(child, 65_536);
    const startedAt = Date.now();
    const outcome = await runCaptureSession({
      source,
      signal: new AbortController().signal,
      clock: systemClock(),
      durationMs: 2000,
      onStats: async () => {
        await new Promise<never>(() => undefined);
      },
    });
    const elapsedMs = Date.now() - startedAt;
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("stalled output must fail the run");
    }
    expect(outcome.error.code).toBe("INTERNAL");
    expect(elapsedMs).toBeLessThan(15000);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 30000);

  it("cancels an active capture without reporting success", async () => {
    const resolved = resolveBundledHelperPath({});
    if (resolved.isErr()) {
      throw new Error("helper must resolve on this machine");
    }
    const spawned = spawnAudioSource({ helperPath: resolved.value, syntheticFrames: 100000 });
    if (spawned.isErr()) {
      throw new Error("synthetic spawn must succeed");
    }
    const controller = new AbortController();
    const outcomePromise = runCaptureSession({
      source: spawned.value,
      signal: controller.signal,
      clock: fixedClock(0),
      durationMs: 30000,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();
    const outcome = await outcomePromise;
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("aborted capture must not succeed");
    }
    expect(outcome.error.code).toBe("CANCELLED");
  });
});

describe("capture backpressure", () => {
  function launchFlood(frames: number): {
    child: ChildProcess;
    finishNatural(timeoutMs: number): Promise<string>;
    terminate(): Promise<string>;
  } {
    const child = spawn(process.execPath, [floodScript, String(frames)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let closed = false;
    const closeWaiters: Array<() => void> = [];
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    child.on("close", () => {
      closed = true;
      for (const wake of closeWaiters.splice(0)) {
        wake();
      }
    });
    const awaitClose = (): Promise<void> =>
      closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            closeWaiters.push(resolve);
          });
    const lastLine = (): string => stderr.trim().split("\n").pop() ?? "";
    return {
      child,
      finishNatural: async (timeoutMs: number): Promise<string> => {
        if (!closed) {
          const finished = await Promise.race([
            awaitClose().then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
          ]);
          if (!finished) {
            throw new Error("flood did not finish on its own");
          }
        }
        return lastLine();
      },
      terminate: async (): Promise<string> => {
        if (!closed) {
          child.kill("SIGTERM");
        }
        await awaitClose();
        return lastLine();
      },
    };
  }

  it("bounds buffered audio while the consumer stalls", async () => {
    const flood = launchFlood(2000);
    const source = new ChildCaptureSource(flood.child, 65_536);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(source.bufferedBytes).toBeLessThan(65_536 + 262_144);
    const report = JSON.parse(await flood.terminate()) as { written: number };
    expect(report.written).toBeLessThan(1_000_000);
    const disposed = await source.dispose();
    expect(disposed.isOk()).toBe(true);
  }, 15000);

  it("lets the flood finish when the bound covers the stream", async () => {
    const flood = launchFlood(2000);
    const source = new ChildCaptureSource(flood.child, 16_777_216);
    const report = JSON.parse(await flood.finishNatural(10000)) as { written: number };
    expect(report.written).toBeGreaterThan(8_000_000);
    const disposed = await source.dispose();
    expect(disposed.isOk()).toBe(true);
  }, 15000);
});

describe("capture shutdown and protocol integrity", () => {
  function launchScript(script: string): { child: ChildProcess } {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr?.resume();
    return { child };
  }

  it("fails closed when the helper ignores SIGTERM", async () => {
    const { child } = launchScript(ignoreSigtermScript);
    const source = new ChildCaptureSource(child, 65_536, 1_000);
    const outcome = await runCaptureSession({
      source,
      signal: new AbortController().signal,
      clock: fixedClock(0),
      durationMs: 3000,
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("an unresponsive helper must fail");
    }
    expect(outcome.error.code).toBe("RESOURCE_RELEASE_FAILED");
    expect(outcome.error.message).toContain("did not stop");
  }, 20000);

  it("rejects trailing bytes after the end acknowledgement", async () => {
    const { child } = launchScript(truncatedTailScript);
    const source = new ChildCaptureSource(child, 65_536);
    const outcome = await runCaptureSession({
      source,
      signal: new AbortController().signal,
      clock: fixedClock(0),
      durationMs: 10000,
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("trailing bytes must fail");
    }
    expect(outcome.error.code).toBe("VALIDATION_FAILED");
  }, 20000);

  it("rejects an abnormal post-end exit instead of reporting clean success", async () => {
    const { child } = launchScript(abruptEndScript);
    const source = new ChildCaptureSource(child, 65_536);
    const outcome = await runCaptureSession({
      source,
      signal: new AbortController().signal,
      clock: fixedClock(0),
      durationMs: 10000,
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("post-end exit failure must surface");
    }
    expect(outcome.error.code).toBe("RESOURCE_RELEASE_FAILED");
  }, 20000);

  it("forces termination when the consumer stalls and the helper ignores SIGTERM", async () => {
    const { child } = launchScript(endlessIgnoreScript);
    const source = new ChildCaptureSource(child, 65_536, 10000);
    const startedAt = Date.now();
    const outcome = await runCaptureSession({
      source,
      signal: new AbortController().signal,
      clock: systemClock(),
      durationMs: 2000,
      onStats: async () => {
        await new Promise<never>(() => undefined);
      },
    });
    const elapsedMs = Date.now() - startedAt;
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("stalled output must fail the run");
    }
    expect(outcome.error.code).toBe("INTERNAL");
    expect(elapsedMs).toBeLessThan(15000);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 30000);

  it("requires observed termination when the helper stays alive after its end", async () => {
    const { child } = launchScript(endThenHangScript);
    const source = new ChildCaptureSource(child, 65_536);
    const seen: SourceItem[] = [];
    for await (const item of source.items(new AbortController().signal)) {
      seen.push(item);
      if (item.type === "end") {
        break;
      }
    }
    expect(seen.some((item) => item.type === "end")).toBe(true);
    const disposed = await source.dispose();
    expect(disposed.isErr()).toBe(true);
    if (disposed.isOk()) {
      throw new Error("live-after-end helper must not dispose cleanly");
    }
    expect(disposed.error.code).toBe("RESOURCE_RELEASE_FAILED");
  }, 20000);

  it("rejects signal termination after an end frame as successful completion", async () => {
    const { child } = launchScript(signalDeathScript);
    const source = new ChildCaptureSource(child, 65_536);
    const outcome = await runCaptureSession({
      source,
      signal: new AbortController().signal,
      clock: fixedClock(0),
      durationMs: 10000,
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isOk()) {
      throw new Error("signal death must not report clean capture");
    }
    expect(outcome.error.code).toBe("RESOURCE_RELEASE_FAILED");
    expect(outcome.error.message).toContain("SIGTERM");
  }, 20000);
});

const realAudioEnabled = process.env["URBUDDY_REAL_AUDIO"] === "1" && helperAvailable;

describe.runIf(realAudioEnabled)("native capture verification", () => {
  function helperPath(): string {
    const resolved = resolveBundledHelperPath({});
    if (resolved.isErr()) {
      throw new Error("helper must resolve on this machine");
    }
    return resolved.value;
  }

  it("starts and stops real capture repeatedly", async () => {
    for (let round = 0; round < 3; round += 1) {
      const spawned = spawnAudioSource({ helperPath: helperPath() });
      if (spawned.isErr()) {
        throw new Error("real helper spawn must succeed");
      }
      const outcome = await runCaptureSession({
        source: spawned.value,
        signal: new AbortController().signal,
        clock: fixedClock(0),
        durationMs: 2000,
      });
      expect(outcome.isOk()).toBe(true);
      if (outcome.isErr()) {
        throw new Error("repeated real capture must complete");
      }
      expect(outcome.value.format).toEqual({ sampleRate: 48000, channels: 2 });
    }
  }, 30000);

  it("propagates native ring overflow into reported gaps", async (ctx) => {
    const sinePath = join(tmpdir(), `urbuddy-overflow-${Date.now()}.wav`);
    writeSineFixture(sinePath, 15);
    const player = spawn("afplay", [sinePath], { stdio: "ignore" });
    const playerStarted = await new Promise<boolean>((resolve) => {
      player.once("spawn", () => resolve(true));
      player.once("error", () => resolve(false));
    });
    if (!playerStarted) {
      rmSync(sinePath, { force: true });
      ctx.skip();
      return;
    }
    try {
      const spawned = spawnAudioSource({
        helperPath: helperPath(),
        ringSlots: 2,
        maxBufferedBytes: 131072,
      });
      if (spawned.isErr()) {
        throw new Error("real helper spawn must succeed");
      }
      const raw = spawned.value;
      const slowSource: CaptureSource = {
        async *items(signal: AbortSignal): AsyncIterable<SourceItem> {
          for await (const item of raw.items(signal)) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            yield item;
          }
        },
        async stop(): Promise<void> {
          await raw.stop();
        },
        dispose: () => raw.dispose(),
      };
      const outcome = await runCaptureSession({
        source: slowSource,
        signal: new AbortController().signal,
        clock: fixedClock(0),
        durationMs: 6000,
      });
      expect(outcome.isOk()).toBe(true);
      if (outcome.isErr()) {
        throw new Error("overflowed run must complete");
      }
      if (!outcome.value.signalPresent) {
        ctx.skip();
        return;
      }
      expect(outcome.value.droppedHelper).toBeGreaterThan(0);
      expect(outcome.value.gaps).toBeGreaterThan(0);
    } finally {
      player.kill();
      rmSync(sinePath, { force: true });
    }
  }, 30000);
});
