import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToString } from "ink";

import { AdaptiveScreen } from "./screen.js";
import type { Size } from "./screen.js";
import { act, advance, initial } from "./session.js";
import type { Session } from "./session.js";

const base = join(fileURLToPath(new URL(".", import.meta.url)), "frames");
mkdirSync(base, { recursive: true });

function frame(name: string, state: Session, size: Size): void {
  const out = renderToString(<AdaptiveScreen state={state} size={size} />, {
    columns: size.columns,
  });
  writeFileSync(join(base, `${name}.ansi`), out);
  process.stdout.write(`${name} ${out.length}\n`);
}

function typeText(state: Session, text: string): Session {
  return text.split("").reduce((current, char) => act(current, `input:${char}`), act(state, "x"));
}

const full: Size = { columns: 86, rows: 28 };
const small: Size = { columns: 44, rows: 11 };

frame("follow", initial(250), full);
frame("question-banner", advance(initial(120, true), 255, true), full);

const ready = act(advance(initial(300, true), 315, false), "r");
frame("respond-ready", ready, full);

const pending = act(advance(initial(300, true), 305, false), "r");
frame("respond-pending", pending, full);

const changed = act(advance(initial(250, true), 280, false), "r");
frame("respond-changed", changed, full);

let stale = typeText(act(advance(initial(300, true), 315, false), "r"), "Run tonight if clear");
stale = act(stale, "enter");
stale = advance(stale, 340, false);
frame("respond-invalidated", stale, full);
frame("respond-history", act(stale, "u"), full);

const recovered = act(advance(initial(150, true), 350, false), "c");
frame("context", recovered, full);

frame("closed", initial(480), full);
frame("degraded", act(advance(initial(300, true), 340, false), "r"), small);
