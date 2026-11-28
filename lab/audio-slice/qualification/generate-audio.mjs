import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), "urbuddy-muse-qualification");
const OUT_DIR = join(new URL(".", import.meta.url).pathname, "audio");
const SAMPLE_RATE = 16000;
const VOICE = "Alex";
const MAX_AUDIO_SECONDS = 30;

const reference = JSON.parse(
  readFileSync(join(new URL(".", import.meta.url).pathname, "reference.json"), "utf8"),
);

mkdirSync(ROOT, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const silenceMs = reference.silenceBetweenTurnsMs;
const rendered = [];
let cursorMs = 400;
for (const turn of reference.turns) {
  const aiff = join(ROOT, `${turn.id}.aiff`);
  execFileSync("say", ["-v", VOICE, "-r", "170", "-o", aiff, turn.text]);
  const wav = join(ROOT, `${turn.id}.wav`);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const bytes = readFileSync(wav);
  const frames = (bytes.length - 44) / 2;
  const durationMs = Math.round((frames / SAMPLE_RATE) * 1000);
  rendered.push({ id: turn.id, text: turn.text, startMs: cursorMs, durationMs });
  cursorMs += durationMs + silenceMs;
}

const audioMs = cursorMs - silenceMs;
if (audioMs > MAX_AUDIO_SECONDS * 1000) {
  throw new Error(`fixture exceeds the ${MAX_AUDIO_SECONDS}s transmission budget: ${audioMs}ms`);
}

const totalSamples = Math.ceil((audioMs / 1000) * SAMPLE_RATE);
const mix = new Float32Array(totalSamples);
const spans = {};
for (const turn of rendered) {
  const wav = join(ROOT, `${turn.id}.wav`);
  const bytes = readFileSync(wav);
  const frames = (bytes.length - 44) / 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset + 44, bytes.length - 44);
  const startSample = Math.round((turn.startMs / 1000) * SAMPLE_RATE);
  for (let i = 0; i < frames; i += 1) {
    mix[startSample + i] += view.getInt16(i * 2, true) / 32768;
  }
  spans[turn.id] = { startMs: turn.startMs, durationMs: turn.durationMs };
  process.stdout.write(
    `${turn.id} start=${turn.startMs}ms dur=${turn.durationMs}ms "${turn.text}"\n`,
  );
}

for (const turn of rendered) {
  const from = Math.round((turn.startMs / 1000) * SAMPLE_RATE);
  const to = from + Math.round((turn.durationMs / 1000) * SAMPLE_RATE);
  let sum = 0;
  for (let i = from; i < to; i += 10) sum += mix[i] * mix[i];
  const rms = Math.sqrt(sum / Math.ceil((to - from) / 10));
  if (rms < 0.01) throw new Error(`turn ${turn.id} is not audible: rms=${rms}`);
}
for (let index = 0; index + 1 < rendered.length; index += 1) {
  const current = rendered[index];
  const next = rendered[index + 1];
  const gapFrom = Math.round(((current.startMs + current.durationMs) / 1000) * SAMPLE_RATE);
  const gapTo = Math.round((next.startMs / 1000) * SAMPLE_RATE);
  let gapSum = 0;
  for (let i = gapFrom; i < gapTo; i += 1) gapSum += mix[i] * mix[i];
  const gapRms = Math.sqrt(gapSum / Math.max(1, gapTo - gapFrom));
  if (gapRms > 0.002)
    throw new Error(`silence ${current.id}->${next.id} is not silent: rms=${gapRms}`);
}
process.stdout.write(`all ${rendered.length - 1} inter-turn silences verified\n`);

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
writeFileSync(join(OUT_DIR, "qualification.wav"), Buffer.concat([header, pcm]));
writeFileSync(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify(
    { sampleRate: SAMPLE_RATE, audioMs, spans, turns: reference.turns.map((t) => t.id) },
    null,
    2,
  ),
);
process.stdout.write(
  `wrote qualification.wav ${(totalSamples * 2 + 44) / 1e6} MB (${audioMs}ms audio)\n`,
);
