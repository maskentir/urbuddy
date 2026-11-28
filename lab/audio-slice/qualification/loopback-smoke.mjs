import { readFileSync } from "node:fs";

import { WebSocketServer } from "ws";

const reference = JSON.parse(readFileSync(new URL("reference.json", import.meta.url), "utf8"));

const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
process.stdout.write(`loopback endpoint: ws://127.0.0.1:${port}\n`);

let turnId = 0;
server.on("connection", (socket) => {
  socket.once("message", (_data, isBinary) => {
    if (!isBinary) socket.send(JSON.stringify({ sessionId: "loopback-smoke" }));
  });
  let processedMs = 0;
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      processedMs += 120;
      socket.send(JSON.stringify({ type: "audioProgress", audioProcessedMs: processedMs }));
      return;
    }
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
          audioProcessedMs: turnId * 1000 + 100,
        }),
      );
      socket.send(
        JSON.stringify({
          type: "transcript",
          transcript: turn.text,
          final: false,
          audioProcessedMs: turnId * 1000 + 200,
        }),
      );
      socket.send(
        JSON.stringify({ type: "speechEnd", turnId, audioProcessedMs: turnId * 1000 + 250 }),
      );
      socket.send(
        JSON.stringify({
          type: "speechComplete",
          turnId,
          transcript: turn.text,
          audioProcessedMs: turnId * 1000 + 300,
        }),
      );
    }
    socket.close(1000);
  });
});
