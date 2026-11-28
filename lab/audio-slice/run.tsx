import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { render } from "ink";

import { openWavSource } from "../../src/adapters/audio/wav-source.js";

import { RuntimeFeed } from "./feed.js";
import { loadFixture } from "./fixture.js";
import { AudioTimeline, nodePlayerDeps } from "./playback.js";
import { AdaptiveApp, type AppController } from "./screen.js";
import { actUser, initialSession, touchLiveView, type Session } from "./session.js";

const HELP = `urbuddy audio slice (bounded lab, bukan sesi P01, bukan STT langsung)

Satu irisan vertikal: audio percakapan berbahasa Inggris yang terdengar,
dengan bantuan pemahaman Indonesia yang tersinkron dari event replay.

  tsx lab/audio-slice/run.tsx --help

Kontrol: Space jeda/lanjut audio · C pulihkan · R respons · Esc live.
Tidak ada percepatan: hanya 1×. Replay deterministik = jalankan ulang.
Transkrip dan terjemahan berasal dari jadwal replay authored, bukan STT.
Keluar: q atau Ctrl-C (keduanya mematikan audio dan menulis trace).`;

const here = fileURLToPath(new URL(".", import.meta.url));
const WAV = join(here, "audio", "meeting.wav");
const TRACE_DIR = join(here, "trace");

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("lab/audio-slice/run.tsx");

interface TraceLine {
  readonly tClockMs: number;
  readonly tWallMs: number;
  readonly monoMs: number;
  readonly kind: string;
  readonly detail: string;
}

if (invokedDirectly) {
  const { values } = parseArgs({ options: { help: { type: "boolean" } } });
  if (values.help === true) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Butuh terminal interaktif. Lihat --help.");
  }

  const opened = await openWavSource(WAV, { pacing: "none" });
  if (opened.isErr()) {
    throw new Error(
      `Audio slice tidak ditemukan atau rusak: ${WAV}. Buat dengan: node lab/audio-slice/tools/generate-audio.mjs`,
    );
  }
  const { info } = opened.value;
  if (info.sampleRate !== 16000 || info.channels !== 1) {
    throw new Error(`Format audio slice tidak didukung: ${info.sampleRate} Hz ${info.channels} ch`);
  }
  await opened.value.dispose().catch(() => undefined);

  const runtime = await loadFixture();
  const feed = new RuntimeFeed({
    sessionId: "audio-slice",
    streamId: "main",
    provider: runtime.provider,
    authoredTranscripts: runtime.authoredTranscripts,
    translations: runtime.translations,
    intelligence: runtime.intelligence,
    gapSkips: runtime.gapSkips,
  });
  const player = new AudioTimeline(nodePlayerDeps(), WAV);
  mkdirSync(TRACE_DIR, { recursive: true });
  const startedWallMs = Date.now();
  const tracePath = join(TRACE_DIR, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const lines: string[] = [];
  const emit = (line: Omit<TraceLine, "tWallMs" | "monoMs">): void => {
    lines.push(
      JSON.stringify({
        ...line,
        tWallMs: Date.now() - startedWallMs,
        monoMs: Math.round(performance.now() * 1000) / 1000,
      }),
    );
  };
  emit({ tClockMs: 0, kind: "audio-start", detail: "afplay spawned; clock is the software clock" });

  const holder: { session: Session } = {
    session: { ...initialSession(feed.domain), running: true },
  };
  let done = false;
  const shutdown = (code: number): void => {
    if (done) return;
    done = true;
    player.stop();
    feed.finish();
    const latency = feed.latencySummary();
    const cpu = process.cpuUsage();
    emit({
      tClockMs: Math.round(player.positionMs()),
      kind: "shutdown",
      detail:
        `runner shutdown pauses=${player.pauseCount} ` +
        `releaseAcceptMs=${JSON.stringify(latency.releaseAcceptMs)} ` +
        `acceptApplyMs=${JSON.stringify(latency.acceptApplyMs)} ` +
        `applyProjectMs=${JSON.stringify(latency.applyProjectMs)} ` +
        `translations=${JSON.stringify(latency.translations)} ` +
        `cpuUserMs=${Math.round(cpu.user / 1000)} cpuSystemMs=${Math.round(cpu.system / 1000)} ` +
        `duplicates=${feed.domain.duplicates} stale=${feed.domain.stale} ` +
        `translationsRejected=${feed.domain.translationsRejected} ` +
        `rejected=${feed.domain.rejected.length}`,
    });
    writeFileSync(tracePath, `${lines.join("\n")}\n`);
    process.stdout.write(`trace: ${tracePath}\n`);
    process.exitCode = code;
  };
  process.on("SIGINT", () => {
    shutdown(130);
    process.exit(130);
  });

  const controller: AppController = {
    actUser: (key, clockMs) => {
      emit({ tClockMs: Math.round(clockMs), kind: "input", detail: key });
      holder.session = actUser(holder.session, key, clockMs);
      emit({
        tClockMs: Math.round(clockMs),
        kind: "view-after-input",
        detail: `${key} -> ${holder.session.user.view}`,
      });
    },
    pauseToggle: () => {
      if (player.timelineState === "playing") {
        const at = Math.round(player.positionMs());
        player.pause();
        emit({ tClockMs: at, kind: "pause", detail: `position frozen at ${at}ms` });
      } else if (player.timelineState === "paused") {
        player.resume();
        emit({
          tClockMs: Math.round(player.positionMs()),
          kind: "resume",
          detail: "position preserved across pause",
        });
      }
    },
    shutdown,
    snapshot: () => holder.session,
    clockMs: () => player.positionMs(),
  };

  feed.start();
  player.start();
  const streamEndMs = runtime.fixture.streamEndMs;
  let feedFinished = false;
  const app = render(<AdaptiveApp controller={controller} />, {
    alternateScreen: true,
    maxFps: 12,
    exitOnCtrlC: false,
  });
  const timer = setInterval(() => {
    const positionMs = player.positionMs();
    const batch = feed.releaseDue(positionMs);
    for (const accepted of batch.accepted) {
      if (accepted.type !== "partial" && accepted.type !== "final") continue;
      emit({
        tClockMs: Math.round(positionMs),
        kind: `transcript-${accepted.type}`,
        detail: `${accepted.utteranceId} r${accepted.revision}: ${accepted.text.slice(0, 80)}`,
      });
    }
    for (const authored of batch.authored) {
      if (authored.event.type !== "discontinuity") continue;
      emit({
        tClockMs: Math.round(authored.atMs),
        kind: "transcript-discontinuity",
        detail: authored.event.detail.slice(0, 120),
      });
    }
    for (const intent of batch.translations) {
      emit({
        tClockMs: Math.round(intent.atMs),
        kind: "translation-fired",
        detail: `${intent.turnRef}: ${intent.text.slice(0, 80)}`,
      });
    }
    for (const intel of batch.intelligence) {
      emit({ tClockMs: Math.round(intel.atMs), kind: `intel-${intel.type}`, detail: intel.type });
    }
    const applied = batch.accepted.length + batch.authored.length + batch.intelligence.length;
    const playing = player.timelineState === "playing" && positionMs < streamEndMs;
    let next = touchLiveView({ ...holder.session, atMs: positionMs, running: playing });
    if (feed.domain.streamEnded && next.user.view !== "closed") {
      next = { ...next, user: { ...next.user, view: "closed" } };
    }
    holder.session = next;
    app.rerender(<AdaptiveApp controller={controller} />);
    if (applied > 0) {
      emit({
        tClockMs: Math.round(positionMs),
        kind: "render-observed",
        detail: `${applied} domain events projected`,
      });
    }
    if (positionMs >= streamEndMs && !feedFinished) {
      feedFinished = true;
      feed.finish();
      player.stop();
    }
    if (feed.fatal !== undefined) {
      emit({ tClockMs: Math.round(positionMs), kind: "fatal", detail: feed.fatal.message });
      shutdown(1);
    }
  }, 100);

  await app.waitUntilExit();
  clearInterval(timer);
}
