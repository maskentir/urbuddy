import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { AudioTimeline, type AudioProcess } from "./playback.js";
import { utterances } from "./scenario.js";

const here = fileURLToPath(new URL(".", import.meta.url));

describe("audio timeline", () => {
  function stubDeps(): {
    deps: { spawnPlayer: (file: string) => AudioProcess; nowMs: () => number };
    clock: { now: number };
    procs: { killed: string[] }[];
  } {
    const clock = { now: 0 };
    const procs: { killed: string[] }[] = [];
    return {
      deps: {
        spawnPlayer: () => {
          const record = { killed: [] as string[] };
          procs.push(record);
          return {
            pid: 4242,
            kill: (signal: "SIGSTOP" | "SIGCONT" | "SIGTERM" | "SIGKILL") => {
              record.killed.push(signal);
              return true;
            },
            onExit: () => undefined,
          };
        },
        nowMs: () => clock.now,
      },
      clock,
      procs,
    };
  }

  test("pause freezes position and resume preserves alignment", () => {
    const { deps, clock, procs } = stubDeps();
    void procs;
    const timeline = new AudioTimeline(deps, "meeting.wav");
    timeline.start();
    clock.now = 5000;
    expect(timeline.positionMs()).toBe(5000);
    timeline.pause();
    clock.now = 15000;
    expect(timeline.positionMs()).toBe(5000);
    timeline.resume();
    clock.now = 17000;
    expect(timeline.positionMs()).toBe(7000);
    expect(timeline.pauseCount).toBe(1);
  });

  test("stop kills the player and freezes the position", () => {
    const { deps, clock, procs } = stubDeps();
    const timeline = new AudioTimeline(deps, "meeting.wav");
    timeline.start();
    clock.now = 3000;
    timeline.stop();
    expect(procs[0]?.killed).toContain("SIGTERM");
    clock.now = 9000;
    expect(timeline.positionMs()).toBe(3000);
    expect(timeline.timelineState).toBe("stopped");
  });

  test("pause and resume send SIGSTOP then SIGCONT", () => {
    const { deps, procs } = stubDeps();
    const timeline = new AudioTimeline(deps, "meeting.wav");
    timeline.start();
    timeline.pause();
    timeline.resume();
    expect(procs[0]?.killed).toEqual(["SIGSTOP", "SIGCONT"]);
  });
});

describe("audio fixture integrity", () => {
  test("manifest offsets match scenario times", () => {
    const manifest = JSON.parse(readFileSync(join(here, "audio", "manifest.json"), "utf8")) as {
      spans: Record<string, { startMs: number; durationMs: number }>;
    };
    for (const item of utterances) {
      const span = manifest.spans[item.id];
      expect(span, `missing span for ${item.id}`).toBeDefined();
      expect(Math.round((span?.startMs ?? -1) / 1000)).toBe(item.at);
    }
  });

  test("generation script speaks the exact scenario text", () => {
    const script = readFileSync(join(here, "tools", "generate-audio.mjs"), "utf8");
    for (const item of utterances) {
      expect(script, `script missing text for ${item.id}`).toContain(item.text);
    }
  });

  test("meeting audio is silent during the gap and audible during speech", () => {
    const raw = readFileSync(join(here, "audio", "meeting.wav"));
    const view = new DataView(raw.buffer, raw.byteOffset + 44);
    const frames = Math.floor((raw.length - 44) / 2);
    const rms = (fromSec: number, toSec: number): number => {
      const from = Math.floor(fromSec * 16000);
      const to = Math.min(frames, Math.floor(toSec * 16000));
      let sum = 0;
      let count = 0;
      for (let i = from; i < to; i += 10) {
        const sample = view.getInt16(i * 2, true) / 32768;
        sum += sample * sample;
        count += 1;
      }
      return Math.sqrt(sum / Math.max(1, count));
    };
    expect(rms(158, 170)).toBeLessThan(0.005);
    expect(rms(42, 47)).toBeGreaterThan(0.01);
    expect(rms(145, 150)).toBeGreaterThan(0.01);
  });

  test("rendering and projection layers do not read the scenario timeline", () => {
    const pure = ["screen.tsx", "session.ts", "projection.ts", "feed.ts"];
    for (const file of pure) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, `${file} must not import scenario`).not.toContain("./scenario");
    }
  });
});
