import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToString } from "ink";

import { RuntimeFeed } from "./feed.js";
import { loadFixture } from "./fixture.js";
import { AdaptiveScreen, type Size } from "./screen.js";
import { actUser, initialSession, touchLiveView, type Session, type UserState } from "./session.js";

const base = join(fileURLToPath(new URL(".", import.meta.url)), "frames");
mkdirSync(base, { recursive: true });

const runtime = await loadFixture();

async function driveTo(positionMs: number): Promise<RuntimeFeed> {
  const feed = new RuntimeFeed({
    sessionId: "audio-slice",
    streamId: "main",
    provider: runtime.provider,
    authoredTranscripts: runtime.authoredTranscripts,
    translations: runtime.translations,
    intelligence: runtime.intelligence,
    gapSkips: runtime.gapSkips,
  });
  feed.start();
  feed.releaseDue(positionMs);
  await feed.idle();
  return feed;
}

function stateAt(feed: RuntimeFeed, positionMs: number, user: UserState): Session {
  return touchLiveView({ domain: feed.domain, user, atMs: positionMs, running: false });
}

function blankUser(feed: RuntimeFeed): UserState {
  return initialSession(feed.domain).user;
}

function frame(name: string, state: Session, size: Size): void {
  const out = renderToString(<AdaptiveScreen state={state} size={size} />, {
    columns: size.columns,
  });
  writeFileSync(join(base, `${name}.ansi`), out);
  process.stdout.write(`${name} ${out.length}\n`);
}

const full: Size = { columns: 86, rows: 28 };
const small: Size = { columns: 44, rows: 11 };

{
  const feed = await driveTo(75000);
  frame("follow", stateAt(feed, 75000, blankUser(feed)), full);
  feed.finish();
  await feed.completion();
}
{
  const feed = await driveTo(100000);
  frame("question-banner", stateAt(feed, 100000, blankUser(feed)), full);
  feed.finish();
  await feed.completion();
}
{
  const feed = await driveTo(135000);
  const ready = actUser(stateAt(feed, 135000, blankUser(feed)), "r", 135000);
  frame("respond-ready", ready, full);
  feed.finish();
  await feed.completion();
}
{
  const feed = await driveTo(125000);
  const pending = actUser(stateAt(feed, 125000, blankUser(feed)), "r", 125000);
  frame("respond-pending", pending, full);
  feed.finish();
  await feed.completion();
}
{
  const feed = await driveTo(115000);
  const changed = actUser(stateAt(feed, 115000, blankUser(feed)), "r", 115000);
  frame("respond-changed", changed, full);
  feed.finish();
  await feed.completion();
}
{
  const feed = await driveTo(130000);
  let stale = stateAt(feed, 130000, blankUser(feed));
  stale = actUser(stale, "r", 130000);
  stale = actUser(stale, "x", 130000);
  for (const char of "Run tonight if clear") stale = actUser(stale, `input:${char}`, 130000);
  stale = actUser(stale, "enter", 130000);
  feed.releaseDue(160000);
  await feed.idle();
  stale = {
    ...stale,
    user: stale.user,
    atMs: 160000,
  };
  frame("respond-invalidated", stale, full);
  frame("respond-history", actUser(stale, "u", 160000), full);
  feed.finish();
  await feed.completion();
  if (feed.fatal !== undefined) throw new Error(feed.fatal.message);
}
{
  const feed = await driveTo(185000);
  const recovered = actUser(stateAt(feed, 185000, blankUser(feed)), "c", 185000);
  frame("context", recovered, full);
  feed.finish();
  await feed.completion();
}
{
  const feed = await driveTo(190000);
  const insufficient = actUser(stateAt(feed, 190000, blankUser(feed)), "r", 190000);
  frame("respond-insufficient", insufficient, full);
  feed.finish();
  await feed.completion();
}
{
  const feed = await driveTo(208000);
  feed.finish();
  await feed.completion();
  if (feed.fatal !== undefined) throw new Error(feed.fatal.message);
  const closedState = stateAt(feed, 208000, blankUser(feed));
  frame("closed", { ...closedState, user: { ...closedState.user, view: "closed" } }, full);
}
{
  const feed = await driveTo(160000);
  const degraded = actUser(stateAt(feed, 160000, blankUser(feed)), "r", 160000);
  frame("degraded", degraded, small);
  feed.finish();
  await feed.completion();
}
