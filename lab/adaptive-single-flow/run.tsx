import { parseArgs } from "node:util";

import { render } from "ink";

import { END_AT, JOIN_AT } from "./scenario.js";
import { AdaptiveApp } from "./screen.js";

const HELP = `urbuddy adaptive single flow (bounded lab experiment, bukan sesi P01)

Mulai live (disarankan):
  tsx lab/adaptive-single-flow/run.tsx

Replay fasilitator (kontrol transpor terpisah):
  tsx lab/adaptive-single-flow/run.tsx --replay [--at S] [--speed N]

Opsi:
  --at S      mulai dari detik S (0..480, default 120)
  --speed N   laju replay 1..60 (default 12, hanya dengan --replay)
  --replay    aktifkan kontrol transpor Space/. untuk evaluasi
  --help      tampilkan bantuan ini

Live: C pulihkan · R respons · Esc live. Tanpa --replay tidak ada Space/.`;

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("lab/adaptive-single-flow/run.tsx");

if (invokedDirectly) {
  const { values } = parseArgs({
    options: {
      at: { type: "string", default: String(JOIN_AT) },
      speed: { type: "string", default: "12" },
      replay: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  const start = Number(values.at);
  const speed = Number(values.speed);
  const valid =
    Number.isInteger(start) &&
    start >= 0 &&
    start <= END_AT &&
    Number.isFinite(speed) &&
    speed >= 1 &&
    speed <= 60;
  if (!valid) throw new Error(`Gunakan --at 0..${END_AT} --speed 1..60 [--replay] [--help]`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Butuh terminal interaktif. Lihat --help.");
  }
  const app = render(<AdaptiveApp start={start} speed={speed} replay={values.replay ?? false} />, {
    alternateScreen: true,
    maxFps: 12,
  });
  await app.waitUntilExit();
}
