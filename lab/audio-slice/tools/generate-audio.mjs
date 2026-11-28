import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), "audio-slice-build");
const OUT_DIR = join(new URL(".", import.meta.url).pathname, "..", "audio");
const SAMPLE_RATE = 16000;
const END_SEC = 208;

const voices = { amara: "Karen", jonas: "Daniel", priya: "Moira", theo: "Eddy" };
const schedule = [
  ["opening-1", "amara", 5, "Nightly analytics exports are slow and search results look stale."],
  ["opening-2", "theo", 18, "Export pages keep timing out after the reporting batch."],
  ["join", "jonas", 30, "Sorry, just joined. Is the export delayed or is the index stale?"],
  [
    "cursor",
    "jonas",
    42,
    "The export cursor marks our position. We can resume from the last stored cursor.",
  ],
  ["throttle", "priya", 58, "The API is throttling us. We back off with jitter before retrying."],
  [
    "cursor-fix",
    "jonas",
    78,
    "The cursor is at offset nine. No, the cursor expired, run a fresh probe.",
  ],
  ["window-question", "amara", 95, "Jonas or Priya, can we run the rebuild tonight?"],
  ["window-clarify", "amara", 108, "Priya, please confirm the disk and the throttle first."],
  [
    "go-question",
    "amara",
    120,
    "Priya, what do you recommend if the disk and the throttle look fine?",
  ],
  [
    "watermark",
    "priya",
    145,
    "Disk watermark reached. Hold the rebuild. The earlier ready note is no longer valid.",
  ],
  ["cursor-probe", "amara", 182, "Jonas, how is the cursor probe?"],
  [
    "closing-line",
    "amara",
    196,
    "Let us stop here. Priya owns the disk check, Jonas owns the probe.",
  ],
];

mkdirSync(ROOT, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const totalSamples = END_SEC * SAMPLE_RATE;
const mix = new Float32Array(totalSamples);
const spans = {};
for (const [id, speaker, atSec, text] of schedule) {
  const aiff = join(ROOT, `${id}.aiff`);
  execFileSync("say", ["-v", voices[speaker], "-o", aiff, text]);
  const wav = join(ROOT, `${id}.wav`);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const bytes = readFileSync(wav);
  const dataBytes = bytes.length - 44;
  const frames = dataBytes / 2;
  const durationMs = Math.round((frames / SAMPLE_RATE) * 1000);
  const startMs = atSec * 1000;
  const endMs = startMs + durationMs;
  const nextIndex = schedule.findIndex((row) => row[0] === id) + 1;
  const nextStart = nextIndex < schedule.length ? schedule[nextIndex][2] * 1000 : END_SEC * 1000;
  if (endMs > nextStart) {
    throw new Error(`utterance ${id} overlaps next slot: ends ${endMs}ms, next at ${nextStart}ms`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + 44, dataBytes);
  const startSample = Math.round((startMs / 1000) * SAMPLE_RATE);
  for (let i = 0; i < frames; i += 1) {
    mix[startSample + i] += view.getInt16(i * 2, true) / 32768;
  }
  spans[id] = { startMs, durationMs };
  process.stdout.write(`${id} at=${atSec}s dur=${(durationMs / 1000).toFixed(2)}s\n`);
}

const gapFrom = 158 * SAMPLE_RATE;
const gapTo = 170 * SAMPLE_RATE;
let gapSum = 0;
for (let i = gapFrom; i < gapTo; i += 1) gapSum += mix[i] * mix[i];
const gapRms = Math.sqrt(gapSum / (gapTo - gapFrom));
if (gapRms > 0.005) throw new Error(`gap region not silent: rms=${gapRms}`);
process.stdout.write(`gap 158-170s rms=${gapRms.toExponential(2)} (silent)\n`);

for (const [id] of schedule) {
  const span = spans[id];
  let sum = 0;
  const from = Math.round((span.startMs / 1000) * SAMPLE_RATE);
  const to = from + Math.round((span.durationMs / 1000) * SAMPLE_RATE);
  for (let i = from; i < to; i += 10) sum += mix[i] * mix[i];
  const rms = Math.sqrt(sum / Math.ceil((to - from) / 10));
  if (rms < 0.01) throw new Error(`utterance ${id} has no audible signal: rms=${rms}`);
}
process.stdout.write("all spans audible\n");

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + totalSamples * 2, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(totalSamples * 2, 40);
const pcm = Buffer.alloc(totalSamples * 2);
for (let i = 0; i < totalSamples; i += 1) {
  const clamped = Math.max(-1, Math.min(1, mix[i]));
  pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
}
writeFileSync(join(OUT_DIR, "meeting.wav"), Buffer.concat([header, pcm]));
writeFileSync(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify({ sampleRate: SAMPLE_RATE, audioMs: END_SEC * 1000, spans }, null, 2),
);
process.stdout.write(`wrote meeting.wav ${(totalSamples * 2 + 44) / 1e6} MB\n`);
