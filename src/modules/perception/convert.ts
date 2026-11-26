import { appError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

import type { AudioFormat } from "./audio.js";

export type PcmEncoding = "PCM_24KHZ" | "PCM_16KHZ";

export interface ConvertedAudio {
  readonly pcm: Buffer;
  readonly outputFrames: number;
}

export interface ConverterStats {
  readonly inputFrames: number;
  readonly outputFrames: number;
  readonly clippedSamples: number;
  readonly gaps: number;
}

const TARGET_RATE = 24_000;
const PASSTHROUGH_RATE = 16_000;
const FIR_TAPS = 63;
const FIR_CUTOFF_HZ = 10_800;

function designLowpass(taps: number, cutoffHz: number, sampleRate: number): Float64Array {
  const coefficients = new Float64Array(taps);
  const center = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const offset = i - center;
    const sinc =
      offset === 0
        ? (2 * cutoffHz) / sampleRate
        : Math.sin((2 * Math.PI * cutoffHz * offset) / sampleRate) / (Math.PI * offset);
    const blackman =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    coefficients[i] = sinc * blackman;
    sum += coefficients[i] as number;
  }
  for (let i = 0; i < taps; i += 1) {
    coefficients[i] = (coefficients[i] as number) / sum;
  }
  return coefficients;
}

export class AudioConverter {
  private readonly encoding: PcmEncoding;
  private readonly resample: boolean;
  private readonly filter: Float64Array | undefined;
  private window: number[] = [];
  private sampleIndex = 0;
  private inputFrames = 0;
  private outputFrames = 0;
  private clippedSamples = 0;
  private gaps = 0;

  private constructor(readonly format: AudioFormat) {
    if (format.sampleRate === TARGET_RATE || format.sampleRate === 48_000) {
      this.encoding = "PCM_24KHZ";
    } else if (format.sampleRate === PASSTHROUGH_RATE) {
      this.encoding = "PCM_16KHZ";
    } else {
      this.encoding = "PCM_24KHZ";
    }
    this.resample = format.sampleRate === 48_000;
    this.filter = this.resample ? designLowpass(FIR_TAPS, FIR_CUTOFF_HZ, 48_000) : undefined;
  }

  static create(format: AudioFormat): Result<AudioConverter, AppError> {
    if (
      !Number.isInteger(format.sampleRate) ||
      format.sampleRate <= 0 ||
      !Number.isInteger(format.channels) ||
      format.channels < 1 ||
      format.channels > 8
    ) {
      return err(appError("VALIDATION_FAILED", "audio format is invalid for conversion"));
    }
    if (
      format.sampleRate !== TARGET_RATE &&
      format.sampleRate !== PASSTHROUGH_RATE &&
      format.sampleRate !== 48_000
    ) {
      return err(
        appError("UNSUPPORTED", "audio conversion supports 16 kHz, 24 kHz, and 48 kHz input only"),
      );
    }
    return ok(new AudioConverter(format));
  }

  get outputEncoding(): PcmEncoding {
    return this.encoding;
  }

  get outputSampleRate(): number {
    return this.encoding === "PCM_24KHZ" ? TARGET_RATE : PASSTHROUGH_RATE;
  }

  get stats(): ConverterStats {
    return {
      inputFrames: this.inputFrames,
      outputFrames: this.outputFrames,
      clippedSamples: this.clippedSamples,
      gaps: this.gaps,
    };
  }

  noteGap(): void {
    this.gaps += 1;
    this.window = [];
    this.sampleIndex = 0;
  }

  convert(samples: Float32Array): Result<ConvertedAudio, AppError> {
    const channels = this.format.channels;
    if (samples.length % channels !== 0) {
      return err(appError("VALIDATION_FAILED", "audio chunk does not match its channel count"));
    }
    const frames = samples.length / channels;
    const mono = new Float64Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        const value = samples[frame * channels + channel] as number;
        if (!Number.isFinite(value)) {
          return err(appError("VALIDATION_FAILED", "audio contains non-finite samples"));
        }
        sum += value;
      }
      mono[frame] = sum / channels;
    }
    this.inputFrames += frames;
    const filtered = this.resample ? this.applyFilter(mono, false) : mono;
    return ok(this.encode(filtered));
  }

  flush(): ConvertedAudio {
    if (!this.resample) {
      return { pcm: Buffer.alloc(0), outputFrames: 0 };
    }
    const tail = this.applyFilter(new Float64Array(0), true);
    return this.encode(tail);
  }

  private applyFilter(mono: Float64Array, flushing: boolean): Float64Array {
    const filter = this.filter as Float64Array;
    const out: number[] = [];
    const feed = (sample: number): void => {
      this.window.push(sample);
      if (this.window.length > filter.length) {
        this.window.shift();
      }
      const index = this.sampleIndex;
      this.sampleIndex += 1;
      if (this.window.length === filter.length && index % 2 === 0) {
        let sum = 0;
        for (let tap = 0; tap < filter.length; tap += 1) {
          sum += (this.window[filter.length - 1 - tap] as number) * (filter[tap] as number);
        }
        out.push(sum);
      }
    };
    for (const sample of mono) {
      feed(sample);
    }
    if (flushing) {
      for (let i = 0; i < filter.length - 1; i += 1) {
        feed(0);
      }
      this.window = [];
      this.sampleIndex = 0;
    }
    return new Float64Array(out);
  }

  private encode(mono: Float64Array): ConvertedAudio {
    const pcm = Buffer.alloc(mono.length * 2);
    for (let i = 0; i < mono.length; i += 1) {
      let value = mono[i] as number;
      if (value > 1 || value < -1) {
        this.clippedSamples += 1;
        value = Math.max(-1, Math.min(1, value));
      }
      pcm.writeInt16LE(Math.round(value * 32_767), i * 2);
    }
    this.outputFrames += mono.length;
    return { pcm, outputFrames: mono.length };
  }
}
