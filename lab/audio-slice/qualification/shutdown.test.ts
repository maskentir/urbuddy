import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";
import { WebSocketServer } from "ws";

import { DEFAULT_TRANSLATION_MODEL } from "../../../src/modules/config/translation.js";

import { estimateCostUsd } from "./translation-budget.js";

const here = fileURLToPath(new URL(".", import.meta.url));

function writeSilentWav(path: string): void {
  const samples = Buffer.alloc(16_000 * 2 * 10);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(samples.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length, 40);
  writeFileSync(path, Buffer.concat([header, samples]));
}

async function startTranslation() {
  const requested = Promise.withResolvers<ServerResponse>();
  const disconnected = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => requested.resolve(response));
    response.on("close", () => disconnected.resolve());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("translation loopback did not bind a TCP port");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requested: requested.promise,
    disconnected: disconnected.promise,
    close: async () => {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

function startRunner(args: string[], endpoint: string, interactive = false) {
  const command = [process.execPath, "--import", "tsx", ...args];
  const runner = interactive
    ? spawn(
        "python3",
        [
          "-c",
          "import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))",
          ...command,
        ],
        runnerOptions(endpoint),
      )
    : spawn(process.execPath, command.slice(1), runnerOptions(endpoint));
  let output = "";
  const traceWritten = Promise.withResolvers<void>();
  runner.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("trace: ")) traceWritten.resolve();
  });
  runner.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return {
    runner,
    output: () => output,
    closed: once(runner, "close"),
    traceWritten: traceWritten.promise,
  };
}

function runnerOptions(endpoint: string) {
  return {
    env: {
      PATH: process.env["PATH"],
      TERM: "xterm",
      TSX_TSCONFIG_PATH: join(here, "..", "tsconfig.json"),
      URBUDDY_TRANSLATE_ENDPOINT: endpoint,
    },
    timeout: 15_000,
  };
}

test.each([
  { name: "q", key: "q", code: 0 },
  { name: "Ctrl-C", key: "\u0003", code: 130 },
])(
  "interactive $name settles an outstanding translation before writing the trace",
  async ({ key, code }) => {
    const directory = mkdtempSync(join(tmpdir(), "urbuddy-quit-"));
    const fixture = join(directory, "silence.wav");
    const trace = join(directory, "quit.jsonl");
    writeSilentWav(fixture);
    const speech = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const speechClosed = Promise.withResolvers<void>();
    speech.on("connection", (socket) => {
      socket.on("close", () => speechClosed.resolve());
      socket.once("message", () => {
        socket.send(JSON.stringify({ sessionId: "loopback-shutdown" }));
        socket.once("message", () => {
          socket.send(
            JSON.stringify({
              type: "speechComplete",
              turnId: 1,
              transcript: "Hold the cache lock.",
              audioProcessedMs: 10,
            }),
          );
        });
      });
    });
    await once(speech, "listening");
    const speechAddress = speech.address();
    if (typeof speechAddress !== "object" || speechAddress === null) {
      throw new Error("speech loopback did not bind a TCP port");
    }
    const translation = await startTranslation();
    const { runner, output, closed, traceWritten } = startRunner(
      [
        join(here, "run-muse.tsx"),
        "--loopback",
        `ws://127.0.0.1:${speechAddress.port}`,
        "--translate",
        "--fixture",
        fixture,
        "--output",
        trace,
      ],
      translation.endpoint,
      true,
    );
    try {
      const started = await Promise.race([
        translation.requested.then(() => true),
        closed.then(() => false),
      ]);
      expect(started, output()).toBe(true);
      runner.stdin.write(key);
      const finalized = await Promise.race([
        traceWritten.then(() => true),
        closed.then(() => false),
      ]);
      expect(finalized, output()).toBe(true);
      const rows = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { kind: string; detail: string; data?: Record<string, unknown> },
        );
      expect(rows.filter((row) => row.kind === "translation-settlement")).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            cancelled: 1,
            committed: 0,
            unresolved: 0,
            unresolvedPublication: false,
            publicationFailures: 0,
          }),
        }),
      ]);
      expect(rows).toContainEqual(
        expect.objectContaining({ kind: "session-closed", detail: "terminate" }),
      );
      expect(rows.filter((row) => row.kind === "shutdown")).toHaveLength(1);
      expect(rows.at(-1)).toMatchObject({ kind: "shutdown", data: { code } });
      expect(await closed, output()).toEqual([code, null]);
      expect(output().match(/trace: /g)).toHaveLength(1);
      expect(output().indexOf("\u001b[?25h")).toBeLessThan(output().indexOf("trace: "));
      expect(output()).toContain("\u001b[?25h");
      await Promise.all([speechClosed.promise, translation.disconnected]);
    } finally {
      runner.kill();
      const speechStopped = once(speech, "close");
      for (const socket of speech.clients) socket.terminate();
      speech.close();
      await Promise.all([closed, speechStopped, translation.close()]);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

test.each([false, true])(
  "translation-only settles the runtime with cancellation=%s",
  async (cancel) => {
    const directory = mkdtempSync(join(tmpdir(), "urbuddy-translation-shutdown-"));
    const trace = join(directory, "input.jsonl");
    const text = JSON.stringify({
      kind: "final-committed",
      data: { utteranceId: "epoch-0-turn-1", revision: 1, text: "Hold the cache lock." },
    });
    writeFileSync(trace, text);
    const sha = createHash("sha256").update(text).digest("hex");
    const model = DEFAULT_TRANSLATION_MODEL;
    const maxInputBytes = 2_048;
    const estimate = estimateCostUsd(model, (maxInputBytes + 2048) / 4, 1024)?.toFixed(6);
    const scope = `model=${model};trace=${sha};maxRequests=1;maxInputBytes=${maxInputBytes};maxOutputTokens=1024;planningEstimateUsd=${estimate}`;
    const translation = await startTranslation();
    const { runner, output, closed } = startRunner(
      [
        join(here, "run-translation.ts"),
        "--trace",
        trace,
        "--trace-sha256",
        sha,
        "--max-requests",
        "1",
        "--max-input-bytes",
        String(maxInputBytes),
        "--owner-authorized",
        "--authorization",
        "loopback-regression",
        "--authorization-scope",
        scope,
      ],
      translation.endpoint,
    );
    try {
      const response = await Promise.race([translation.requested, closed.then(() => undefined)]);
      if (response === undefined) throw new Error(output());
      if (cancel) {
        runner.kill("SIGINT");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "chat.completion",
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({ translation: "Tahan kunci cache." }),
                },
                finish_reason: "stop",
              },
            ],
          }),
        );
      }
      const code = cancel ? 130 : 0;
      expect(await closed, output()).toEqual([code, null]);
      expect(output()).toContain(
        `shutdown: code=${code} unresolved=0 unresolvedPublication=false publicationFailures=0`,
      );
      expect(output()).toContain(cancel ? "committed=0" : "committed=1");
      expect(output()).toContain(cancel ? "cancelled=1" : "translation: Tahan kunci cache.");
      await translation.disconnected;
    } finally {
      runner.kill();
      await Promise.all([closed, translation.close()]);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
