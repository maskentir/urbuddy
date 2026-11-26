import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
const entry = resolve(root, "src", "bootstrap", "main.ts");

async function waitForOutput(
  read: () => string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!pattern.test(read())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${String(pattern)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runUntilSignalled(
  signal: NodeJS.Signals,
): Promise<{ code: number | null; output: string }> {
  let output = "";
  const child = spawn(process.execPath, [tsxCli, entry, "--ink-smoke", "--ink-dwell-ms", "30000"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: unknown) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk: unknown) => {
    output += String(chunk);
  });
  try {
    await waitForOutput(() => output, /app started/, 20000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill(signal);
    const [code] = (await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for exit")), 15000);
      }),
    ])) as [number | null];
    return { code, output };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function runToCompletion(): Promise<{ code: number | null; output: string }> {
  let output = "";
  const child = spawn(process.execPath, [tsxCli, entry, "--ink-smoke", "--ink-dwell-ms", "50"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: unknown) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk: unknown) => {
    output += String(chunk);
  });
  try {
    const [code] = (await Promise.race([
      once(child, "exit"),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for exit")), 15000);
      }),
    ])) as [number | null];
    return { code, output };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

describe("shutdown signals", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "exits cancelled on %s during a run",
    async (signal) => {
      const { code, output } = await runUntilSignalled(signal);
      expect(code).toBe(130);
      expect(output).toContain("ready");
    },
    60000,
  );

  it("completes the smoke path with exit zero", async () => {
    const { code, output } = await runToCompletion();
    expect(code).toBe(0);
    expect(output).toContain("ink smoke ok");
  }, 60000);
});
