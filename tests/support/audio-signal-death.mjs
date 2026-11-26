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

function audioFrame() {
  const payload = Buffer.alloc(12);
  payload.writeBigUInt64LE(0n, 0);
  payload.writeFloatLE(0.1, 8);
  return Buffer.concat([header(1, 1, 12), payload]);
}

function endFrame() {
  const payload = Buffer.alloc(34);
  payload.writeBigUInt64LE(1n, 0);
  payload.writeBigUInt64LE(1n, 8);
  payload.writeBigUInt64LE(0n, 16);
  payload.writeUInt16LE(0, 24);
  payload.writeBigUInt64LE(1n, 26);
  return Buffer.concat([header(2, 2, 34), payload]);
}

stdout.write(formatFrame());
stdout.write(audioFrame());
stdout.write(endFrame());
process.kill(process.pid, "SIGTERM");
