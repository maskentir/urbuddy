import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

const cli = fileURLToPath(new URL("../dist/bootstrap/main.js", import.meta.url));
const evidenceRoot =
  process.env.URBUDDY_TERMINAL_EVIDENCE ?? mkdtempSync(join(tmpdir(), "urbuddy-terminal-"));
mkdirSync(evidenceRoot, { recursive: true });

const sourceText = "Hold crate nineteen at the second gate.";
const translatedText = "Tahan peti sembilan belas di gerbang kedua.";
const partialText = "Hold crate nineteen";

function makeWavFixture() {
  const sampleRate = 24_000;
  const frames = sampleRate * 2;
  const pcm = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    pcm.writeInt16LE(
      Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * index) / sampleRate)),
      index * 2,
    );
  }
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const data = Buffer.alloc(8);
  data.write("data");
  data.writeUInt32LE(pcm.length, 4);
  const body = Buffer.concat([fmt, data, pcm]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF");
  riff.writeUInt32LE(4 + body.length, 4);
  const path = join(evidenceRoot, "fixture.wav");
  writeFileSync(path, Buffer.concat([riff, Buffer.from("WAVE"), body]));
  return { path, pcmSha256: createHash("sha256").update(pcm).digest("hex") };
}

function startMuse(changes) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const events = [];
  let socket;
  let activeTurn = 0;
  let inputEnded = false;
  const note = (type, detail = {}) => {
    events.push({ type, ms: performance.now(), ...detail });
    changes.emit("change");
  };
  const send = (payload) => socket.send(JSON.stringify(payload));
  server.on("connection", (client) => {
    socket = client;
    activeTurn += 1;
    let bytes = 0;
    client.on("close", () => note("socket-closed"));
    client.once("message", () => {
      send({ sessionId: `terminal-smoke-${activeTurn}` });
      note("handshake");
      client.on("message", (data, binary) => {
        if (binary) {
          if (bytes === 0) {
            note("first-audio");
            send({ type: "speechStart", turnId: activeTurn, audioProcessedMs: 0 });
            send({
              type: "transcript",
              transcript: partialText,
              final: false,
              audioProcessedMs: 50,
            });
          }
          bytes += data.length;
        } else if (data.toString().includes("endStream")) {
          inputEnded = true;
          note("input-ended", { bytes });
        }
      });
    });
  });
  return {
    server,
    events,
    listening: once(server, "listening"),
    final: () => {
      const final = {
        type: "speechComplete",
        turnId: activeTurn,
        transcript: sourceText,
        audioProcessedMs: 100,
      };
      send(final);
      send(final);
      note("final");
    },
    reconnect: () => socket.close(1011, "synthetic reconnect"),
    complete: () => {
      assert.equal(inputEnded, true);
      socket.close(1000);
    },
  };
}

function startTranslation(changes, fail) {
  const requests = [];
  let disconnected = 0;
  let pending;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    response.on("close", () => {
      disconnected += 1;
      changes.emit("change");
    });
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      pending = response;
      if (fail) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "synthetic provider failure" } }));
      }
      changes.emit("change");
    });
  });
  server.listen(0, "127.0.0.1");
  return {
    server,
    requests,
    listening: once(server, "listening"),
    get disconnected() {
      return disconnected;
    },
    release: () => {
      assert(pending && !pending.destroyed);
      pending.writeHead(200, { "content-type": "application/json" });
      pending.end(
        JSON.stringify({
          id: "terminal-smoke",
          object: "chat.completion",
          model: "gpt-6.1-terra",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({ translation: translatedText }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    },
  };
}

const relay = String.raw`
import errno, fcntl, json, os, pty, select, struct, sys, termios
def resize(fd, rows, columns):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
pid, master = pty.fork()
if pid == 0:
    resize(1, 24, 100)
    os.execv(sys.argv[1], sys.argv[1:])
while True:
    ready, _, _ = select.select([master, sys.stdin], [], [])
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    if sys.stdin in ready:
        line = sys.stdin.readline()
        if not line:
            os.close(master)
            break
        command = json.loads(line)
        if isinstance(command, str):
            os.write(master, command.encode())
        else:
            resize(master, *command)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

async function runCase(name, fixture) {
  const changes = new EventEmitter();
  const muse = startMuse(changes);
  const translator = startTranslation(changes, name === "provider-failure");
  await Promise.all([muse.listening, translator.listening]);
  const child = spawn(
    "python3",
    [
      "-c",
      relay,
      process.execPath,
      cli,
      "--allow-egress",
      "transcribe",
      "--file",
      fixture.path,
      "--translate",
      "--interactive",
    ],
    {
      env: {
        PATH: process.env.PATH,
        TERM: "xterm-256color",
        FORCE_COLOR: "1",
        URBUDDY_TRANSCRIBE_ENDPOINT: `ws://127.0.0.1:${muse.server.address().port}`,
        URBUDDY_TRANSLATE_ENDPOINT: `http://127.0.0.1:${translator.server.address().port}/v1`,
      },
      timeout: 30_000,
    },
  );
  let exited = false;
  const close = once(child, "close").then((result) => {
    exited = true;
    changes.emit("change");
    return result;
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    changes.emit("change");
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    errors += chunk;
  });
  const command = (data) => child.stdin.write(`${JSON.stringify(data)}\n`);
  const checked = [];
  const wait = async (label, predicate) => {
    const signal = AbortSignal.timeout(7_000);
    try {
      while (!predicate()) {
        assert(!exited, "PTY exited early");
        await once(changes, "change", { signal });
      }
      checked.push(label);
    } catch (error) {
      throw new Error(`${name}: ${label} failed`, { cause: error });
    }
  };
  const frame = (stage) => writeFileSync(join(evidenceRoot, `${name}-${stage}.ansi`), output);
  const commandAndWait = async (data, required) => {
    const offset = output.length;
    command(data);
    await wait(required, () => output.slice(offset).includes(required));
  };
  try {
    await wait("source partial rendered", () => output.includes(`${partialText} …`));
    assert.equal(translator.requests.length, 0);
    if (name === "reconnect") {
      muse.reconnect();
      await wait("reconnect reported", () => /\b[1-9]\d* gaps?\b/.test(output));
      await wait(
        "second speech connection",
        () => muse.events.filter((event) => event.type === "first-audio").length === 2,
      );
    }
    if (name === "normal") await commandAndWait("h", "urbuddy · History");
    muse.final();
    await wait("exactly one final request", () => translator.requests.length === 1);
    if (name !== "provider-failure") {
      await wait("pending source and translation", () =>
        output.includes(`${sourceText} · translation pending`),
      );
    }
    const [request] = translator.requests;
    assert.equal(request.max_completion_tokens, 1024);
    const payload = JSON.parse(request.messages.find((message) => message.role === "user").content);
    assert.equal(payload.source, sourceText);

    if (name === "q" || name === "ctrl-c") {
      assert.equal(translator.disconnected, 0);
      command(name === "q" ? "q" : "\x03");
      await wait("translation request settled", () => translator.disconnected === 1);
      await wait("stopped surface", () => output.includes("stopped"));
    } else {
      if (name === "provider-failure") {
        await wait("failure with source visible", () =>
          output.includes(`${sourceText} · translation failed`),
        );
      } else {
        translator.release();
        await wait("delayed independent translation publication", () =>
          output.includes(translatedText),
        );
      }
      if (name === "normal") {
        const history = output.lastIndexOf("urbuddy · History");
        assert(
          history > output.lastIndexOf("urbuddy · Live"),
          "translation should preserve history mode",
        );
        assert(
          output.slice(history).includes(`› ${translatedText}`),
          "translation should preserve the selected utterance",
        );
        frame("history");
        await commandAndWait("o", `original: ${sourceText}`);
        frame("original");
        await commandAndWait("d", "history rows expired");
        await commandAndWait("\x1b", "urbuddy · Live");
        await commandAndWait("o", translatedText);
        await commandAndWait([8, 48], "h history · Esc live · q stop");
        frame("narrow");
        await commandAndWait([24, 100], "↑↓/h history");
        frame("live");
      }
      await wait("paced WAV stream finished", () =>
        muse.events.some((event) => event.type === "input-ended"),
      );
      if (name !== "reconnect") {
        const first = muse.events.find((event) => event.type === "first-audio");
        const ended = muse.events.find((event) => event.type === "input-ended");
        assert.equal(ended.bytes, 96_000);
        assert(ended.ms - first.ms >= 1_500, "source should stream at normal speed");
      }
      muse.complete();
      await wait("normal session completion", () => output.includes("completed"));
    }
    assert.deepEqual(await close, [name === "ctrl-c" ? 130 : 0, null]);
    if (name === "q" || name === "ctrl-c") assert(!output.includes(translatedText));
    assert.equal(translator.requests.length, 1);
    assert.equal(translator.disconnected, 1);
    assert.equal(muse.server.clients.size, 0);
    return { name, checked, status: child.exitCode, sourceEvents: muse.events };
  } finally {
    writeFileSync(join(evidenceRoot, `${name}.ansi`), output);
    writeFileSync(join(evidenceRoot, `${name}.stderr.txt`), errors);
    child.stdin.end();
    await close;
    for (const socket of muse.server.clients) socket.terminate();
    translator.server.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => muse.server.close(resolve)),
      new Promise((resolve) => translator.server.close(resolve)),
    ]);
  }
}

const fixture = makeWavFixture();
assert.equal(fixture.pcmSha256, "f2a7976c8cf240b27df7b8201ae31040a67b319479d25073c83c8d786f1e3a28");
const results = [];
for (const name of ["normal", "provider-failure", "q", "ctrl-c", "reconnect"]) {
  results.push(await runCase(name, fixture));
}
writeFileSync(join(evidenceRoot, "manifest.json"), `${JSON.stringify({ results }, null, 2)}\n`);
console.log(`smoke-terminal: PASS evidence=${evidenceRoot}`);
