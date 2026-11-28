import {
  buildAuthoredSchedules,
  buildProviderSchedule,
  type AuthoredTranscript,
  type GapSkip,
  type ProviderScheduleItem,
  type SliceFixture,
  type TranslationIntent,
} from "./adapter.js";
import type { IntelligenceEvent } from "./projection.js";
import {
  END_AT,
  closing,
  changes,
  coverage,
  participants,
  questions,
  recaps,
  suggestions,
  utterances,
} from "./scenario.js";

export type { SliceFixture };

export interface FixtureRuntime {
  readonly fixture: SliceFixture;
  readonly provider: ProviderScheduleItem[];
  readonly authoredTranscripts: AuthoredTranscript[];
  readonly translations: TranslationIntent[];
  readonly intelligence: IntelligenceEvent[];
  readonly gapSkips: GapSkip[];
}

export async function loadFixture(): Promise<FixtureRuntime> {
  const manifest = (await import("./audio/manifest.json", { with: { type: "json" } })).default as {
    spans: Record<string, { startMs: number; durationMs: number }>;
  };
  const fixture: SliceFixture = {
    utterances: utterances.map((item) => {
      const span = manifest.spans[item.id];
      if (span === undefined) throw new Error(`manifest lacks span for ${item.id}`);
      return {
        id: item.id,
        text: item.text,
        speakerKey: item.speaker,
        startMs: span.startMs,
        durationMs: span.durationMs,
        ...(item.vocab === undefined ? {} : { vocab: item.vocab }),
        ...(item.intent === undefined ? {} : { intent: item.intent }),
        expectsTranslation: item.translation !== undefined,
        ...(item.translation === undefined
          ? {}
          : item.translationAt === undefined
            ? { translationText: item.translation }
            : { translationAtMs: item.translationAt * 1000, translationText: item.translation }),
      };
    }),
    questions: questions.map((item) => ({
      id: item.id,
      atMs: item.at * 1000,
      text: item.text,
      meaning: item.meaning,
      addressee: item.addressee,
      evidence: [...item.evidence],
    })),
    suggestions: suggestions.map((item) => ({
      questionId: item.questionId,
      suggestAtMs: item.suggestAt * 1000,
      draftEn: item.draftEn,
      draftId: item.draftId,
      holdingEn: item.holdingEn,
      holdingId: item.holdingId,
    })),
    changes: changes.map((item) => ({
      id: item.id,
      atMs: item.at * 1000,
      affects: [...item.affects],
      invalidates: item.invalidates,
      text: item.text,
    })),
    recaps: recaps.map((item) => ({
      atMs: item.at * 1000,
      fromMs: item.from * 1000,
      throughMs: item.through * 1000,
      text: item.text,
      evidence: [...item.evidence],
    })),
    gaps: coverage.map((item) => ({
      atMs: item.at * 1000,
      detail: item.text,
      reason: item.reason,
      skipSeq: item.skipSeq ?? 0,
    })),
    participants: participants.map((item) => ({
      speakerKey: item.id,
      name: item.name,
      role: item.role,
    })),
    closing,
    streamEndMs: END_AT * 1000,
  };
  const authored = buildAuthoredSchedules(fixture);
  return {
    fixture,
    provider: buildProviderSchedule(fixture.utterances, (key) => key),
    authoredTranscripts: authored.transcripts,
    translations: authored.translations,
    intelligence: authored.intelligence,
    gapSkips: authored.gapSkips,
  };
}
