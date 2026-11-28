import { parseArgs } from "node:util";

import { render } from "ink";

import { concepts, MeetingLab } from "./lab.js";
import { END_AT, JOIN_AT } from "./model.js";

const { values } = parseArgs({
  options: {
    concept: { type: "string", default: "attention" },
    at: { type: "string", default: String(JOIN_AT) },
    speed: { type: "string", default: "12" },
    play: { type: "boolean" },
  },
});
const concept = concepts.find((item) => item === values.concept);
const start = Number(values.at);
const speed = Number(values.speed);
if (
  !concept ||
  !Number.isSafeInteger(start) ||
  start < 0 ||
  start > END_AT ||
  !Number.isFinite(speed) ||
  speed < 1 ||
  speed > 60
) {
  throw new Error("Use --concept companion|workspace|attention, --at 0..1800, --speed 1..60");
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("The meeting lab needs an interactive terminal.");
}
const app = render(
  <MeetingLab concept={concept} start={start} speed={speed} play={values.play ?? false} />,
  { alternateScreen: true, maxFps: 12 },
);
await app.waitUntilExit();
