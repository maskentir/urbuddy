import { stdout } from "node:process";

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
  payload.writeUInt16LE(1, 4);
  payload.writeUInt16LE(1, 6);
  return Buffer.concat([header(0, 0, 8), payload]);
}

function audioFrame(seq, startSample) {
  const payload = Buffer.alloc(12);
  payload.writeBigUInt64LE(BigInt(startSample), 0);
  payload.writeFloatLE(0.1, 8);
  return Buffer.concat([header(1, seq, payload.byteLength), payload]);
}

process.on("SIGTERM", () => {});

stdout.write(formatFrame());
let seq = 1;
let startSample = 0;
const timer = setInterval(() => {
  if (!stdout.write(audioFrame(seq, startSample))) {
    clearInterval(timer);
  }
  seq += 1;
  startSample += 1;
}, 20);
