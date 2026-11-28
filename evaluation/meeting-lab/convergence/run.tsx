import { parseArgs } from "node:util";

import { render } from "ink";

import { END_AT, JOIN_AT } from "../model.js";

import { Conversation } from "./screen.js";
import { DEFAULT_ROLES, type Language } from "./session.js";

const { values } = parseArgs({
  options: {
    at: { type: "string", default: String(JOIN_AT) },
    speed: { type: "string", default: "12" },
    wide: { type: "boolean" },
    play: { type: "boolean" },
    comprehension: { type: "string", default: DEFAULT_ROLES.comprehension },
    reply: { type: "string", default: DEFAULT_ROLES.reply },
  },
});
const start = Number(values.at);
const speed = Number(values.speed);
const isLanguage = (value: string | undefined): value is Language =>
  value === "id" || value === "en";
if (
  !Number.isInteger(start) ||
  start < 0 ||
  start > END_AT ||
  !Number.isFinite(speed) ||
  speed < 1 ||
  speed > 60 ||
  !isLanguage(values.comprehension) ||
  !isLanguage(values.reply)
) {
  throw new Error("Use --at 0..1800 --speed 1..60 --comprehension id|en --reply id|en");
}
if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error("This simulation needs an interactive terminal.");
const app = render(
  <Conversation
    start={start}
    speed={speed}
    play={values.play ?? false}
    wide={values.wide ?? false}
    roles={{ comprehension: values.comprehension, reply: values.reply }}
  />,
  { alternateScreen: true, maxFps: 12 },
);
await app.waitUntilExit();
