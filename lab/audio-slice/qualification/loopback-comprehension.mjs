import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

const here = fileURLToPath(new URL(".", import.meta.url));
const reference = JSON.parse(readFileSync(join(here, "reference.json"), "utf8"));

const speech = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((resolve) => speech.once("listening", resolve));
const speechPort = speech.address().port;
let turnId = 0;
speech.on("connection", (socket) => {
  socket.once("message", (_data, isBinary) => {
    if (!isBinary) socket.send(JSON.stringify({ sessionId: "loopback-speech" }));
  });
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    if (!data.toString().includes("endStream")) return;
    for (const turn of reference.turns) {
      turnId += 1;
      const words = turn.text.split(" ");
      const first = words.slice(0, Math.ceil(words.length / 2)).join(" ");
      socket.send(JSON.stringify({ type: "speechStart", turnId, audioProcessedMs: turnId * 1000 }));
      socket.send(
        JSON.stringify({
          type: "transcript",
          transcript: first,
          final: false,
          audioProcessedMs: turnId * 1000,
        }),
      );
      socket.send(
        JSON.stringify({
          type: "transcript",
          transcript: turn.text,
          final: false,
          audioProcessedMs: turnId * 1000 + 100,
        }),
      );
      socket.send(
        JSON.stringify({ type: "speechEnd", turnId, audioProcessedMs: turnId * 1000 + 150 }),
      );
      socket.send(
        JSON.stringify({
          type: "speechComplete",
          turnId,
          transcript: turn.text,
          audioProcessedMs: turnId * 1000 + 200,
        }),
      );
    }
    socket.close(1000);
  });
});

const translation = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk.toString("utf8");
  });
  request.on("end", () => {
    const parsed = body.length === 0 ? {} : JSON.parse(body);
    const user = (parsed.messages ?? []).find((message) => message.role === "user");
    const source = JSON.parse(user?.content ?? "{}").source ?? "";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-loopback",
        object: "chat.completion",
        created: 1,
        model: "gpt-6.1-terra",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({ translation: `id: ${source}` }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
      }),
    );
  });
});
await new Promise((resolve) => translation.listen(0, "127.0.0.1", resolve));
const translationPort = translation.address().port;

process.stdout.write(`speech loopback: ws://127.0.0.1:${speechPort}\n`);
process.stdout.write(`translation loopback: http://127.0.0.1:${translationPort}/v1\n`);

const runner = spawn(
  join(here, "..", "..", "..", "node_modules", ".bin", "tsx"),
  [
    "--tsconfig",
    join(here, "..", "tsconfig.json"),
    join(here, "run-muse.tsx"),
    "--loopback",
    `ws://127.0.0.1:${speechPort}`,
    "--translate",
    "--headless",
  ],
  {
    env: {
      ...process.env,
      URBUDDY_TRANSLATE_ENDPOINT: `http://127.0.0.1:${translationPort}/v1`,
    },
    stdio: "inherit",
  },
);
runner.on("exit", (code) => {
  speech.close();
  translation.close();
  process.exit(code ?? 0);
});
