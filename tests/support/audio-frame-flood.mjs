import { stdout, argv, stdin } from "node:process";

const frameCount = Number.parseInt(argv[2] ?? "2000", 10);
const samplesPerFrame = 512;
const channels = 2;

function header(kind, seq, payloadLen) {
  const out = Buffer.alloc(20);
  out.writeUInt32LE(0x55424431, 0);
  out.writeUInt16LE(kind, 4);
  out.writeUInt16LE(1, 6);
  out.writeBigUInt64LE(BigInt(seq), 8);
  out.writeUInt32LE(payloadLen, 16);
  return out;
}

function formatFrame() {
  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(48000, 0);
  payload.writeUInt16LE(channels, 4);
  payload.writeUInt16LE(1, 6);
  return Buffer.concat([header(0, 0, 8), payload]);
}

function audioFrame(seq, startSample) {
  const payload = Buffer.alloc(8 + samplesPerFrame * channels * 4);
  payload.writeBigUInt64LE(BigInt(startSample), 0);
  for (let i = 8; i < payload.byteLength; i += 4) {
    payload.writeFloatLE(0, i);
  }
  return Buffer.concat([header(1, seq, payload.byteLength), payload]);
}

function endFrame(seq, delivered) {
  const payload = Buffer.alloc(34);
  payload.writeBigUInt64LE(BigInt(delivered), 0);
  payload.writeBigUInt64LE(BigInt(delivered), 8);
  payload.writeBigUInt64LE(0n, 16);
  payload.writeUInt16LE(0, 24);
  payload.writeBigUInt64LE(BigInt(delivered * samplesPerFrame), 26);
  return Buffer.concat([header(2, seq, 34), payload]);
}

let written = 0;
let drained = 0;
let stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
});

const frames = [formatFrame()];
for (let seq = 1; seq <= frameCount; seq += 1) {
  frames.push(audioFrame(seq, (seq - 1) * samplesPerFrame));
}
frames.push(endFrame(frameCount + 1, frameCount));

let index = 0;
function pump() {
  while (!stopped && index < frames.length) {
    const chunk = frames[index];
    index += 1;
    written += chunk.byteLength;
    if (!stdout.write(chunk)) {
      drained += 1;
      stdout.once("drain", pump);
      return;
    }
  }
}

pump();
const report = setInterval(() => {
  if (stopped) {
    clearInterval(report);
    process.stderr.write(JSON.stringify({ written, drained, frames: index }) + "\n");
    process.exit(0);
  }
}, 50);
setInterval(() => {
  if (index >= frames.length && !stopped) {
    process.stderr.write(JSON.stringify({ written, drained, frames: index }) + "\n");
    process.exit(0);
  }
}, 50);
stdin.resume();
