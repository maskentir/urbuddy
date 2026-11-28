import { RuntimeFeed } from "./feed.js";
import { loadFixture } from "./fixture.js";

export interface ReferenceLine {
  readonly tClockMs: number;
  readonly kind: string;
  readonly detail: string;
}

export async function buildReferenceTrace(): Promise<ReferenceLine[]> {
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
  feed.start();
  const lines: ReferenceLine[] = [];
  for (let position = 0; position <= runtime.fixture.streamEndMs; position += 100) {
    const batch = feed.releaseDue(position);
    for (const accepted of batch.accepted) {
      if (accepted.type !== "partial" && accepted.type !== "final") continue;
      lines.push({
        tClockMs: batch.positionMs,
        kind: `transcript-${accepted.type}`,
        detail: `${accepted.utteranceId} r${accepted.revision}: ${accepted.text.slice(0, 80)}`,
      });
    }
    for (const authored of batch.authored) {
      if (authored.event.type !== "discontinuity") continue;
      lines.push({
        tClockMs: batch.positionMs,
        kind: "transcript-discontinuity",
        detail: authored.event.detail.slice(0, 120),
      });
    }
    for (const intent of batch.translations) {
      lines.push({
        tClockMs: batch.positionMs,
        kind: "translation-fired",
        detail: `${intent.turnRef}: ${intent.text.slice(0, 80)}`,
      });
    }
    for (const intel of batch.intelligence) {
      lines.push({
        tClockMs: batch.positionMs,
        kind: `intel-${intel.type}`,
        detail: intel.type,
      });
    }
  }
  feed.finish();
  await feed.completion();
  if (feed.fatal !== undefined) throw new Error(feed.fatal.message);
  lines.push({
    tClockMs: runtime.fixture.streamEndMs,
    kind: "replay-end",
    detail:
      `applied=${feed.domain.utterances.length} ` +
      `duplicates=${feed.domain.duplicates} stale=${feed.domain.stale} ` +
      `translationsRejected=${feed.domain.translationsRejected} ` +
      `rejected=${feed.domain.rejected.length}`,
  });
  return lines;
}

export function serializeReference(lines: readonly ReferenceLine[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}
