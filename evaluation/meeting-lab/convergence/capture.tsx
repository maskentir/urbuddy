import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToString } from "ink";
import stripAnsi from "strip-ansi";

import { ConversationScreen } from "./screen.js";
import { act, advance, initial, type Session } from "./session.js";

const base = fileURLToPath(new URL(".", import.meta.url));
const output = join(base, "screenshots");
const respond = (at: number, wide = false) => act(act(initial(at, wide), "r"), "d");
const first = respond(605);
const prepared = ["x", "input:Hold until staging evidence is confirmed.", "enter"].reduce(
  act,
  respond(644, true),
);
const marked = act(initial(183), "m");
const frames: readonly [string, number, number, Session][] = [
  ["respond-58x22", 58, 22, first],
  ["respond-86x28", 86, 28, first],
  ["respond-120x33", 120, 33, respond(605, true)],
  ["draft-migration-failed", 86, 28, advance(prepared, 662)],
  ["draft-failure-wide", 120, 33, advance(prepared, 662)],
  ["late-translation", 86, 28, act(initial(334), "t")],
  ["recovery-point-evicted", 58, 22, act(advance(marked, 445), "c")],
  ["long-draft-short", 44, 11, { ...respond(644), scroll: 7 }],
  ["resize-during-input", 44, 11, ["x", "input:Still here after resizing."].reduce(act, prepared)],
];
const temporary = mkdtempSync(join(tmpdir(), "urbuddy-convergence-frames-"));
try {
  mkdirSync(output, { recursive: true });
  const rasterizer = join(temporary, "screenshot");
  execFileSync("swiftc", [join(base, "../screenshot.swift"), "-o", rasterizer], {
    stdio: "inherit",
  });
  for (const [name, columns, rows, state] of frames) {
    const frame = renderToString(<ConversationScreen state={state} size={{ columns, rows }} />, {
      columns,
    });
    const lines = stripAnsi(frame).trimEnd().split("\n");
    if (lines.length > rows || lines.some((line) => Array.from(line).length > columns)) {
      throw new Error(`Ink frame ${name} exceeds ${columns}×${rows}`);
    }
    const ansi = join(temporary, "frame.ansi");
    writeFileSync(ansi, frame);
    execFileSync(rasterizer, [ansi, join(output, `${name}.png`), String(columns), String(rows)]);
    console.log(`${name} · ${lines.filter((line) => line.trim()).length} nonblank / ${rows} rows`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
