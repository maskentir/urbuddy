import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToString } from "ink";
import stripAnsi from "strip-ansi";

import { concepts, initialState, LabScreen, press } from "./lab.js";

const base = fileURLToPath(new URL(".", import.meta.url));
const output = join(base, "screenshots");
const dimensions = [
  { columns: 58, rows: 22 },
  { columns: 86, rows: 28 },
  { columns: 120, rows: 33 },
];
const comparison = concepts.flatMap((concept) =>
  dimensions.map((size) => ({
    anchor: undefined,
    name: `${concept}-${size.columns}x${size.rows}-respond`,
    concept,
    at: 605,
    keys: "rd",
    ...size,
  })),
);
const stress = [
  { name: "late-arrival", at: 183, keys: "c" },
  { name: "overload", at: 829, keys: "" },
  { name: "gap", at: 1_210, keys: "i" },
  { name: "reversal", at: 1_530, keys: "c", anchor: 482 },
  { name: "closure", at: 1_800, keys: "v" },
].map((frame) => ({ ...frame, concept: "attention" as const, columns: 86, rows: 28 }));

const temporary = mkdtempSync(join(tmpdir(), "urbuddy-meeting-frames-"));
try {
  mkdirSync(output, { recursive: true });
  const rasterizer = join(temporary, "screenshot");
  execFileSync("swiftc", [join(base, "screenshot.swift"), "-o", rasterizer], { stdio: "inherit" });
  for (const { name, concept, at, keys, columns, rows, anchor } of [...comparison, ...stress]) {
    const state = Array.from(keys).reduce((previous, key) => press(previous, key), {
      ...initialState(at),
      ...(anchor !== undefined ? { anchor } : {}),
    });
    const frame = renderToString(<LabScreen {...{ concept, state, columns, rows }} />, { columns });
    const lines = stripAnsi(frame).trimEnd().split("\n");
    if (lines.length > rows || lines.some((line) => Array.from(line).length > columns)) {
      throw new Error(`Frame ${name} exceeds its terminal dimensions`);
    }
    const ansi = join(temporary, "frame.ansi");
    writeFileSync(ansi, frame);
    execFileSync(rasterizer, [ansi, join(output, `${name}.png`), String(columns), String(rows)]);
    console.log(`${name}  ${lines.length}/${rows} rows`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
