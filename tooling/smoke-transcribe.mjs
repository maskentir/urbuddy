import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(root, "dist", "bootstrap", "main.js");

const EVIDENCE_ROOT = join(root, "evaluation", "speech", "results");

function fail(message) {
  console.error(`smoke-transcribe: FAIL: ${message}`);
  process.exitCode = 1;
}

if (!existsSync(cli)) {
  fail(`compiled CLI missing at ${cli} (run pnpm build first)`);
  process.exit(1);
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = join(EVIDENCE_ROOT, `smoke-${runId}`);
mkdirSync(evidenceDir, { recursive: true });

const manifest = {
  tool: "smoke-transcribe",
  commit: "unknown",
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  startedAt: new Date().toISOString(),
  runs: [],
};

try {
  const { execFileSync } = await import("node:child_process");
  manifest.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
} catch {
  manifest.commit = "unknown";
}

function writeEvidence(name, content) {
  const path = join(evidenceDir, name);
  writeFileSync(path, content);
  return path;
}

function makeWavFixture() {
  const sampleRate = 24_000;
  const seconds = 2;
  const frames = sampleRate * seconds;
  const dataBytes = frames * 2;
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const header = Buffer.alloc(8);
  header.write("data", 0);
  header.writeUInt32LE(dataBytes, 4);
  const pcm = Buffer.alloc(dataBytes);
  for (let i = 0; i < frames; i += 1) {
    pcm.writeInt16LE(
      Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)),
      i * 2,
    );
  }
  const body = Buffer.concat([fmt, header, pcm]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0);
  riff.writeUInt32LE(4 + body.length, 4);
  const path = join(evidenceDir, "fixture.wav");
  writeFileSync(path, Buffer.concat([riff, Buffer.from("WAVE"), body]));
  return {
    path,
    expectedPcmBytes: dataBytes,
    sha256: createHash("sha256").update(pcm).digest("hex"),
  };
}

function startServer() {
  const events = [];
  const stamp = (kind, detail = {}) => events.push({ at: Date.now(), kind, ...detail });
  const connections = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const listening = once(wss, "listening");
  wss.on("connection", (socket) => {
    const conn = {
      audioBytes: 0,
      ackAt: 0,
      firstAudioAt: 0,
      endStreamSeen: false,
      closeCode: null,
    };
    connections.push(conn);
    stamp("connection", { index: connections.length });
    socket.once("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const text = data.toString();
      stamp("handshake", { bytes: text.length, mode: handshakeMode(text) });
      socket.send(JSON.stringify({ sessionId: "smoke-session" }));
      conn.ackAt = Date.now();
      stamp("ack-sent", { index: connections.length });
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        conn.audioBytes += data.length;
        if (conn.firstAudioAt === 0) {
          conn.firstAudioAt = Date.now();
        }
        return;
      }
      if (data.toString().includes("endStream")) {
        conn.endStreamSeen = true;
        stamp("endStream", { index: connections.length, audioBytes: conn.audioBytes });
        socket.send(JSON.stringify({ type: "speechStart", turnId: 1, audioProcessedMs: 100 }));
        socket.send(
          JSON.stringify({
            type: "transcript",
            transcript: "smoke",
            final: false,
            audioProcessedMs: 500,
          }),
        );
        socket.send(
          JSON.stringify({
            type: "speechComplete",
            turnId: 1,
            transcript: "Smoke final.",
            audioProcessedMs: 900,
          }),
        );
        socket.close(1000);
      }
    });
    socket.on("close", (code) => {
      conn.closeCode = code;
      stamp("close", { code });
    });
    socket.on("error", () => undefined);
  });
  return {
    wss,
    listening,
    events,
    connectionCount: () => connections.length,
    latest: () => connections[connections.length - 1],
  };
}

function handshakeMode(text) {
  try {
    return JSON.parse(text).mode ?? "unknown";
  } catch {
    return "unparseable";
  }
}

function lastSourceBlock(userText) {
  return JSON.parse(userText).source;
}

function startTranslationStub() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let source = "";
      try {
        const parsed = JSON.parse(body);
        const userMessage = (parsed.messages ?? []).find((m) => m.role === "user");
        source = lastSourceBlock(userMessage?.content ?? "");
      } catch {
        source = "";
      }
      const translation = `ID-SMOKE: ${source}`;
      requests.push({
        url: req.url,
        authorization: req.headers["authorization"],
        model: (() => {
          try {
            return JSON.parse(body).model;
          } catch {
            return undefined;
          }
        })(),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "smoke-translation",
          object: "chat.completion",
          created: 1,
          model: "gpt-6-luna",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify({ translation }) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  return { server, listening, requests };
}

const FORBIDDEN_FLAGS = ["--allow-child", "--persist", "--data-root"];

function childEnv(extra) {
  for (const flag of FORBIDDEN_FLAGS) {
    if (extra.args !== undefined && extra.args.includes(flag)) {
      throw new Error(`loopback smoke must not request ${flag}`);
    }
  }
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...extra.env,
  };
}

function runCli(args, env, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { env, timeout: timeoutMs, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const timedOut =
          error?.killed === true && error.code === null && error.signal === "SIGKILL";
        resolve({
          code: timedOut ? "timeout" : error === null ? 0 : (error.code ?? "null"),
          signal: error?.signal ?? null,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
        });
      },
    ).stdin.end();
  });
}

function readEvents(stdout, assertions) {
  try {
    const events = stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    check(assertions, "ndjson-parseable", true);
    return events;
  } catch {
    check(assertions, "ndjson-parseable", false);
    return [];
  }
}

function check(assertions, name, pass, detail = "") {
  assertions.push({ name, pass, detail });
  return pass;
}

async function positiveRun({ mode, json, fixture, server, port, label }) {
  const name = `transcribe-${label}`;
  const connIndex = server.connectionCount();
  const args = ["transcribe", "--file", fixture.path, "--allow-egress", "--mode", mode];
  if (json) {
    args.push("--json");
  }
  const result = await runCli(
    args,
    childEnv({
      args,
      env: {
        URBUDDY_TRANSCRIBE_ENDPOINT: `ws://127.0.0.1:${port}`,
        URBUDDY_TRANSLATION_PROVIDER: "openai",
        URBUDDY_OPENAI_API_KEY: "unused-translation-fixture",
      },
    }),
    120_000,
  );
  const stdoutPath = writeEvidence(`${name}.stdout.txt`, result.stdout);
  const stderrPath = writeEvidence(`${name}.stderr.txt`, result.stderr);
  const assertions = [];
  check(assertions, "exit-code-0", result.code === 0, `code=${result.code}`);
  check(assertions, "no-timeout", !result.timedOut, "");
  check(assertions, "translation-off-with-config", !result.stdout.includes("translation"), "");
  const conn = server.latest();
  check(
    assertions,
    "single-connection",
    server.connectionCount() === connIndex + 1,
    `connections=${server.connectionCount()} want=${connIndex + 1}`,
  );
  check(assertions, "connection-established", conn !== undefined, "");
  check(
    assertions,
    "audio-bytes-exact",
    conn !== undefined && conn.audioBytes === fixture.expectedPcmBytes,
    `got=${conn === undefined ? "none" : conn.audioBytes} want=${fixture.expectedPcmBytes}`,
  );
  check(
    assertions,
    "audio-after-ack",
    conn !== undefined && conn.firstAudioAt >= conn.ackAt && conn.firstAudioAt > 0,
    "",
  );
  check(assertions, "endStream-observed", conn !== undefined && conn.endStreamSeen === true, "");
  if (json) {
    const complete = readEvents(result.stdout, assertions).findLast(
      (event) => event.type === "complete",
    );
    check(assertions, "final-transcript-present", result.stdout.includes("Smoke final."), "");
    check(
      assertions,
      "complete-summary",
      complete !== undefined && complete.finals >= 1 && complete.providerId === "muse",
      JSON.stringify(complete),
    );
  } else {
    check(assertions, "final-transcript-present", result.stdout.includes("Smoke final."), "");
    check(assertions, "summary-present", result.stdout.includes("transcription complete"), "");
  }
  manifest.runs.push({
    name,
    args,
    env: { endpoint: "loopback", credential: "none-sentinel-only", isolation: "allowlist" },
    exitCode: result.code,
    durationMs: result.durationMs,
    stdoutPath,
    stderrPath,
    assertions,
  });
  return assertions.every((a) => a.pass);
}

async function bilingualRun({ fixture, port, translatePort, translateStub, label }) {
  const name = `transcribe-${label}`;
  const envFile = writeEvidence(
    "bilingual-fixture.env",
    [
      "URBUDDY_STT_PROVIDER=muse",
      "URBUDDY_STT_MODEL=muse-voice-transcribe-1.0",
      "URBUDDY_TRANSLATION_SOURCE_LANGUAGE=en",
      "URBUDDY_TRANSLATION_TARGET_LANGUAGE=ja",
      "URBUDDY_TRANSLATION_MODEL=gpt-6.1-terra",
      "URBUDDY_META_API_KEY=fixture-speech-only",
      "URBUDDY_OPENAI_API_KEY=fixture-translation-only",
    ].join("\n"),
  );
  const args = [
    "--env-file",
    envFile,
    "transcribe",
    "--target-language",
    "id",
    "--file",
    fixture.path,
    "--allow-egress",
    "--mode",
    "endpointing",
    "--json",
    "--translate",
  ];
  const result = await runCli(
    args,
    childEnv({
      args,
      env: {
        URBUDDY_TRANSCRIBE_ENDPOINT: `ws://127.0.0.1:${port}`,
        URBUDDY_TRANSLATION_TARGET_LANGUAGE: "ko",
        URBUDDY_TRANSLATION_MODEL: "gpt-6-luna",
        URBUDDY_TRANSLATE_ENDPOINT: `http://127.0.0.1:${translatePort}`,
      },
    }),
    120_000,
  );
  const stdoutPath = writeEvidence(`${name}.stdout.txt`, result.stdout);
  const stderrPath = writeEvidence(`${name}.stderr.txt`, result.stderr);
  const assertions = [];
  check(assertions, "exit-code-0", result.code === 0, `code=${result.code}`);
  check(assertions, "no-timeout", !result.timedOut, "");
  const events = readEvents(result.stdout, assertions);
  const complete = events.findLast((event) => event.type === "complete");
  const translationComplete = events.findLast((event) => event.type === "translation-complete");
  check(assertions, "english-final-present", result.stdout.includes("Smoke final."), "");
  check(
    assertions,
    "source-partial-present",
    events.some((event) => event.type === "partial" && event.text === "smoke"),
    "",
  );
  check(
    assertions,
    "indonesian-committed-present",
    result.stdout.includes("ID-SMOKE: Smoke final."),
    "",
  );
  check(
    assertions,
    "translation-summary",
    translationComplete !== undefined &&
      translationComplete.sourceLanguage === "en" &&
      translationComplete.targetLanguage === "id" &&
      translationComplete.finalized === 1 &&
      translationComplete.committed === 1 &&
      translationComplete.requests === 1 &&
      translationComplete.provisionals === 0 &&
      translationComplete.promptVersion === "urbuddy-translation-v3" &&
      translationComplete.unresolvedInvocations === 0 &&
      translationComplete.unresolvedPublication === false &&
      translationComplete.failed === false,
    JSON.stringify(translationComplete),
  );
  check(
    assertions,
    "complete-carries-translation",
    complete !== undefined &&
      complete.translation !== undefined &&
      complete.translation.committed >= 1,
    JSON.stringify(complete),
  );
  check(
    assertions,
    "exactly-one-final-translation-request",
    translateStub.requests.length === 1 && events.every((event) => event.type !== "provisional"),
    `requests=${translateStub.requests.length}`,
  );
  check(
    assertions,
    "translation-uses-sentinel-credential",
    translateStub.requests.length >= 1 &&
      translateStub.requests.every(
        (r) => r.authorization === "Bearer loopback-translate-credential",
      ),
    "only the loopback sentinel is permitted",
  );
  check(
    assertions,
    "translation-pinned-model",
    translateStub.requests.length >= 1 &&
      translateStub.requests.every((r) => r.model === "gpt-6-luna"),
    JSON.stringify(translateStub.requests.map((r) => r.model)),
  );
  manifest.runs.push({
    name,
    args,
    env: {
      endpoint: "loopback",
      translationEndpoint: "loopback-stub",
      credential: "none-sentinel-only",
      isolation: "allowlist",
    },
    exitCode: result.code,
    durationMs: result.durationMs,
    stdoutPath,
    stderrPath,
    assertions,
  });
  return assertions.every((a) => a.pass);
}

async function denialRun({ name, args, extraEnv, expectCode, endpoint }) {
  const result = await runCli(args, childEnv({ args, env: extraEnv }), 30_000);
  const stdoutPath = writeEvidence(`${name}.stdout.txt`, result.stdout);
  const stderrPath = writeEvidence(`${name}.stderr.txt`, result.stderr);
  const assertions = [];
  check(
    assertions,
    "exit-code",
    result.code === expectCode,
    `code=${result.code} want=${expectCode}`,
  );
  check(assertions, "no-timeout", !result.timedOut, "");
  manifest.runs.push({
    name,
    args,
    env: {
      endpoint: endpoint ?? "default",
      credential: "none-or-unset",
      isolation: "allowlist",
    },
    exitCode: result.code,
    durationMs: result.durationMs,
    stdoutPath,
    stderrPath,
    assertions,
  });
  return assertions.every((a) => a.pass);
}

const fixture = makeWavFixture();
const server = startServer();
const translateStub = startTranslationStub();
let allPass = true;
try {
  await Promise.all([server.listening, translateStub.listening]);
  const address = server.wss.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const translateAddress = translateStub.server.address();
  const translatePort =
    typeof translateAddress === "object" && translateAddress !== null ? translateAddress.port : 0;

  allPass =
    (await positiveRun({
      mode: "endpointing",
      json: true,
      fixture,
      server,
      port,
      label: "endpointing-json",
    })) && allPass;
  allPass =
    (await positiveRun({
      mode: "diarization",
      json: false,
      fixture,
      server,
      port,
      label: "diarization-text",
    })) && allPass;

  allPass =
    (await bilingualRun({
      fixture,
      port,
      translatePort,
      translateStub,
      label: "bilingual-endpointing-json",
    })) && allPass;

  allPass =
    (await denialRun({
      name: "deny-no-egress",
      args: ["transcribe", "--file", fixture.path],
      extraEnv: {},
      expectCode: 3,
      endpoint: "n/a",
    })) && allPass;
  const deniedEnv = writeEvidence(
    "deny-egress-fixture.env",
    [
      "URBUDDY_ALLOW_EGRESS=1",
      "URBUDDY_META_API_KEY=fixture-speech-only",
      "URBUDDY_OPENAI_API_KEY=fixture-translation-only",
    ].join("\n"),
  );
  allPass =
    (await denialRun({
      name: "deny-translate-no-egress",
      args: ["--env-file", deniedEnv, "transcribe", "--file", fixture.path, "--translate"],
      extraEnv: {},
      expectCode: 3,
      endpoint: "n/a",
    })) && allPass;
  allPass =
    (await denialRun({
      name: "deny-evil-endpoint",
      args: ["transcribe", "--file", fixture.path, "--allow-egress"],
      extraEnv: { URBUDDY_TRANSCRIBE_ENDPOINT: "ws://evil.example.com/x" },
      expectCode: 2,
      endpoint: "remote-plaintext-rejected",
    })) && allPass;
  allPass =
    (await denialRun({
      name: "deny-malformed-endpoint",
      args: ["transcribe", "--file", fixture.path, "--allow-egress"],
      extraEnv: { URBUDDY_TRANSCRIBE_ENDPOINT: "::not-a-url::" },
      expectCode: 2,
      endpoint: "malformed-rejected",
    })) && allPass;
} catch (thrown) {
  allPass = false;
  manifest.harnessError =
    thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
} finally {
  const cleanup = new AbortController();
  for (const socket of server.wss.clients) {
    socket.terminate();
  }
  const websocketClosed = new Promise((resolve) => server.wss.close((error) => resolve(!error)));
  const httpClosed = new Promise((resolve) =>
    translateStub.server.close((error) => resolve(!error)),
  );
  translateStub.server.closeAllConnections();
  const closed = await Promise.race([
    Promise.all([websocketClosed, httpClosed]).then((results) => results.every(Boolean)),
    delay(5_000, false, { signal: cleanup.signal }),
  ]);
  cleanup.abort();
  if (!closed) {
    allPass = false;
    manifest.cleanupError = "loopback server shutdown failed or exceeded 5 seconds";
  }
  writeEvidence(
    "server-events.jsonl",
    server.events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  manifest.serverEvents = server.events.length;
  manifest.serverConnections = server.connectionCount();
  manifest.fixture = {
    frames: 48000,
    expectedPcmBytes: fixture.expectedPcmBytes,
    sha256: fixture.sha256,
  };
  manifest.finishedAt = new Date().toISOString();
  manifest.pass = allPass;
  writeEvidence("manifest.json", JSON.stringify(manifest, null, 2));
}

console.log(`smoke-transcribe: ${allPass ? "PASS" : "FAIL"} evidence=${evidenceDir}`);
if (!allPass) {
  for (const run of manifest.runs) {
    for (const assertion of run.assertions) {
      if (!assertion.pass) {
        console.log(`  FAIL ${run.name}/${assertion.name} ${assertion.detail}`);
      }
    }
  }
  if (manifest.harnessError !== undefined) {
    console.log(`  FAIL harness/${manifest.harnessError}`);
  }
  if (manifest.cleanupError !== undefined) {
    console.log(`  FAIL cleanup/${manifest.cleanupError}`);
  }
  process.exit(1);
}
