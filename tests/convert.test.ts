import { AudioConverter } from "@modules/perception/convert";
import { describe, expect, it } from "vitest";

function sine(freq: number, rate: number, frames: number, channels: number): Float32Array {
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i += 1) {
    const value = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
    for (let c = 0; c < channels; c += 1) {
      out[i * channels + c] = value;
    }
  }
  return out;
}

function rms(pcm: Buffer): number {
  let sum = 0;
  const count = pcm.length / 2;
  for (let i = 0; i < count; i += 1) {
    const value = pcm.readInt16LE(i * 2) / 32_767;
    sum += value * value;
  }
  return Math.sqrt(sum / count);
}

function convertAll(converter: AudioConverter, samples: Float32Array, chunk: number): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < samples.length; offset += chunk) {
    const result = converter.convert(samples.subarray(offset, offset + chunk));
    if (result.isErr()) {
      throw new Error(result.error.message);
    }
    parts.push(result.value.pcm);
  }
  parts.push(converter.flush().pcm);
  return Buffer.concat(parts);
}

describe("AudioConverter", () => {
  it("preserves a 440 Hz signal through 48 kHz stereo to 24 kHz mono conversion", () => {
    const created = AudioConverter.create({ sampleRate: 48_000, channels: 2 });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) return;
    const pcm = convertAll(created.value, sine(440, 48_000, 48_000, 2), 4096);
    expect(pcm.length / 2).toBe(24_000);
    expect(rms(pcm)).toBeGreaterThan(0.33);
    expect(rms(pcm)).toBeLessThan(0.37);
    expect(created.value.outputEncoding).toBe("PCM_24KHZ");
  });

  it("attenuates an 18 kHz tone instead of aliasing it into the output band", () => {
    const created = AudioConverter.create({ sampleRate: 48_000, channels: 1 });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) return;
    const pcm = convertAll(created.value, sine(18_000, 48_000, 48_000, 1), 4096);
    expect(rms(pcm)).toBeLessThan(0.01);
  });

  it("produces identical output regardless of chunk boundaries", () => {
    const first = AudioConverter.create({ sampleRate: 48_000, channels: 1 });
    const second = AudioConverter.create({ sampleRate: 48_000, channels: 1 });
    expect(first.isOk() && second.isOk()).toBe(true);
    if (first.isErr() || second.isErr()) return;
    const signal = sine(440, 48_000, 9600, 1);
    expect(convertAll(first.value, signal, signal.length)).toEqual(
      convertAll(second.value, signal, 100),
    );
  });

  it("passes 24 kHz mono through without resampling", () => {
    const created = AudioConverter.create({ sampleRate: 24_000, channels: 1 });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) return;
    const result = created.value.convert(new Float32Array([0, 0.5, -0.5]));
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.pcm.readInt16LE(2)).toBe(16_384);
    expect(created.value.outputEncoding).toBe("PCM_24KHZ");
  });

  it("selects PCM_16KHZ for 16 kHz input", () => {
    const created = AudioConverter.create({ sampleRate: 16_000, channels: 1 });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) return;
    expect(created.value.outputEncoding).toBe("PCM_16KHZ");
  });

  it("rejects unsupported sample rates and non-finite samples", () => {
    expect(AudioConverter.create({ sampleRate: 22_050, channels: 1 }).isErr()).toBe(true);
    const created = AudioConverter.create({ sampleRate: 24_000, channels: 1 });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) return;
    expect(created.value.convert(new Float32Array([Number.NaN])).isErr()).toBe(true);
    expect(created.value.convert(new Float32Array([Number.POSITIVE_INFINITY])).isErr()).toBe(true);
  });

  it("resets resampler state on a capture gap so unrelated audio is not bridged", () => {
    const created = AudioConverter.create({ sampleRate: 48_000, channels: 1 });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) return;
    convertAll(created.value, sine(440, 48_000, 4800, 1), 4800);
    created.value.noteGap();
    expect(created.value.stats.gaps).toBe(1);
    const after = created.value.convert(sine(440, 48_000, 960, 1));
    expect(after.isOk()).toBe(true);
  });

  it("accounts startup, steady state, and flush output exactly", () => {
    const created = AudioConverter.create({ sampleRate: 48_000, channels: 1 });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) {
      return;
    }
    const signal = sine(440, 48_000, 4800, 1);
    const first = created.value.convert(signal.subarray(0, 4800));
    expect(first.isOk()).toBe(true);
    if (first.isErr()) {
      return;
    }
    expect(first.value.outputFrames).toBe(2369);
    const tail = created.value.flush();
    expect(tail.outputFrames).toBe(31);
    expect(created.value.stats).toEqual({
      inputFrames: 4800,
      outputFrames: 2400,
      clippedSamples: 0,
      gaps: 0,
    });
  });

  it("round-trips 24 kHz mono PCM16 within one least-significant bit", () => {
    const created = AudioConverter.create({ sampleRate: 24_000, channels: 1 });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) {
      return;
    }
    const frames = 2400;
    const samples = sine(440, 24_000, frames, 1);
    const result = created.value.convert(samples);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }
    expect(result.value.pcm.length).toBe(frames * 2);
    let worst = 0;
    for (let i = 0; i < frames; i += 1) {
      const expected = Math.round((samples[i] as number) * 32_767);
      const actual = result.value.pcm.readInt16LE(i * 2);
      worst = Math.max(worst, Math.abs(actual - expected));
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it("counts clipped samples while clamping output", () => {
    const created = AudioConverter.create({ sampleRate: 24_000, channels: 1 });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) return;
    const result = created.value.convert(new Float32Array([2, -2]));
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.pcm.readInt16LE(0)).toBe(32_767);
    expect(created.value.stats.clippedSamples).toBe(2);
  });
});
