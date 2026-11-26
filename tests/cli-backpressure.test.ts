import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
const entry = resolve(root, "src", "bootstrap", "main.ts");

describe("replay backpressure", () => {
  it("blocks on a slow stdout consumer instead of buffering unbounded output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "urbuddy-bp-"));
    const path = join(dir, "big.ndjson");
    const text = "x".repeat(200);
    const lines = Array.from({ length: 3000 }, (_, i) =>
      JSON.stringify({
        sessionId: "s-1",
        streamId: "st-1",
        seq: i,
        kind: "partial",
        utteranceId: `u${i}`,
        revision: 0,
        text,
      }),
    );
    writeFileSync(path, lines.join("\n") + "\n", "utf8");
    const child = spawn(process.execPath, [tsxCli, entry, "replay", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      let output = "";
      child.stdout.on("data", (chunk: unknown) => {
        output += String(chunk);
      });
      child.stdout.resume();
      const code = await new Promise<number | null>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for exit")), 30000);
        child.once("exit", (exitCode) => {
          clearTimeout(timer);
          resolvePromise(exitCode);
        });
      });
      expect(code).toBe(0);
      expect(output).toContain("replay complete: applied=3000");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
