import { appError } from "@kernel/errors";
import type { AudioChunk, AudioFormat, HelperEnd, SourceItem } from "@modules/perception/audio";

const FRAME_MAGIC = 0x55424431;
const FRAME_VERSION = 1;
const HEADER_BYTES = 20;
const MAX_PAYLOAD_BYTES = 1_048_576;
const FORMAT_TAG_FLOAT32_LE = 1;

const KIND_FORMAT = 0;
const KIND_AUDIO = 1;
const KIND_END = 2;

const END_FORMAT_PAYLOAD_BYTES = 8;
const END_PAYLOAD_BYTES = 34;

function readU64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw appError("VALIDATION_FAILED", "audio frame counter exceeds safe range");
  }
  return Number(value);
}

function decodePayload(kind: number, seq: number, payload: Buffer): SourceItem {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (kind === KIND_FORMAT) {
    if (payload.byteLength !== END_FORMAT_PAYLOAD_BYTES) {
      throw appError("VALIDATION_FAILED", "audio format frame has an unexpected size");
    }
    const tag = view.getUint16(6, true);
    if (tag !== FORMAT_TAG_FLOAT32_LE) {
      throw appError("VALIDATION_FAILED", "audio helper reported an unsupported encoding");
    }
    const format: AudioFormat = {
      sampleRate: view.getUint32(0, true),
      channels: view.getUint16(4, true),
    };
    if (format.sampleRate === 0 || format.channels === 0 || format.channels > 8) {
      throw appError("VALIDATION_FAILED", "audio helper reported an invalid format");
    }
    return { type: "format", seq, format };
  }
  if (kind === KIND_AUDIO) {
    if (payload.byteLength < 8 || (payload.byteLength - 8) % 4 !== 0) {
      throw appError("VALIDATION_FAILED", "audio frame payload is misaligned");
    }
    const startSample = readU64(view, 0);
    const floats = new Float32Array(
      payload.buffer.slice(payload.byteOffset + 8, payload.byteOffset + payload.byteLength),
    );
    for (const value of floats) {
      if (!Number.isFinite(value)) {
        throw appError("VALIDATION_FAILED", "audio helper sent a non-finite sample");
      }
    }
    const chunk: AudioChunk = { seq, startSample, samples: floats };
    return { type: "audio", chunk };
  }
  if (kind === KIND_END) {
    if (payload.byteLength !== END_PAYLOAD_BYTES) {
      throw appError("VALIDATION_FAILED", "audio end frame has an unexpected size");
    }
    const reason = view.getUint16(24, true);
    if (reason !== 0 && reason !== 1) {
      throw appError("VALIDATION_FAILED", "audio helper reported an unknown end reason");
    }
    const end: HelperEnd = {
      captured: readU64(view, 0),
      delivered: readU64(view, 8),
      dropped: readU64(view, 16),
      reason: reason === 1 ? "cancelled" : "completed",
      sourceFrames: readU64(view, 26),
    };
    return { type: "end", seq, end };
  }
  throw appError("VALIDATION_FAILED", "audio helper sent an unknown frame kind");
}

export class FrameDecoder {
  private pending = Buffer.alloc(0);

  get hasPending(): boolean {
    return this.pending.byteLength > 0;
  }

  push(data: Buffer): SourceItem[] {
    this.pending = Buffer.concat([this.pending, data]);
    const items: SourceItem[] = [];
    while (this.pending.byteLength >= HEADER_BYTES) {
      const view = new DataView(this.pending.buffer, this.pending.byteOffset, HEADER_BYTES);
      if (view.getUint32(0, true) !== FRAME_MAGIC) {
        throw appError("VALIDATION_FAILED", "unrecognized audio frame");
      }
      const kind = view.getUint16(4, true);
      if (kind !== KIND_FORMAT && kind !== KIND_AUDIO && kind !== KIND_END) {
        throw appError("VALIDATION_FAILED", "audio helper sent an unknown frame kind");
      }
      if (view.getUint16(6, true) !== FRAME_VERSION) {
        throw appError("VALIDATION_FAILED", "unsupported audio protocol version");
      }
      const seq = readU64(view, 8);
      const payloadLen = view.getUint32(16, true);
      if (payloadLen > MAX_PAYLOAD_BYTES) {
        throw appError("VALIDATION_FAILED", "audio frame exceeds its size bound");
      }
      if (this.pending.byteLength < HEADER_BYTES + payloadLen) {
        return items;
      }
      const payload = this.pending.subarray(HEADER_BYTES, HEADER_BYTES + payloadLen);
      items.push(decodePayload(kind, seq, payload));
      this.pending = this.pending.subarray(HEADER_BYTES + payloadLen);
    }
    return items;
  }
}
