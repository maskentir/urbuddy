import type { SpeechProviderEvent, TranscriptEvent } from "../../src/modules/perception/speech.js";

import type { IntelligenceEvent } from "./projection.js";

export interface ProviderScheduleItem {
  readonly atMs: number;
  readonly event: SpeechProviderEvent;
}

export interface AuthoredTranscript {
  readonly atMs: number;
  readonly event: TranscriptEvent;
}

export interface TranslationIntent {
  readonly atMs: number;
  readonly turnRef: string;
  readonly text: string;
  readonly sourceRevision?: number;
}

export interface GapSkip {
  readonly atMs: number;
  readonly skip: number;
}

export interface FixtureUtterance {
  readonly id: string;
  readonly text: string;
  readonly speakerKey: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly vocab?: string;
  readonly intent?: string;
  readonly expectsTranslation: boolean;
  readonly translationAtMs?: number;
  readonly translationText?: string;
}

export interface FixtureQuestion {
  readonly id: string;
  readonly atMs: number;
  readonly text: string;
  readonly meaning: string;
  readonly addressee: string;
  readonly evidence: readonly string[];
}

export interface FixtureSuggestion {
  readonly questionId: string;
  readonly suggestAtMs: number;
  readonly draftEn: string;
  readonly draftId: string;
  readonly holdingEn: string;
  readonly holdingId: string;
}

export interface FixtureChange {
  readonly id: string;
  readonly atMs: number;
  readonly affects: readonly string[];
  readonly invalidates: boolean;
  readonly text: string;
}

export interface FixtureRecap {
  readonly atMs: number;
  readonly fromMs: number;
  readonly throughMs: number;
  readonly text: string;
  readonly evidence: readonly string[];
}

export interface FixtureGap {
  readonly atMs: number;
  readonly detail: string;
  readonly reason: "capture-gap" | "reconnect";
  readonly skipSeq: number;
}

export interface FixtureParticipant {
  readonly speakerKey: string;
  readonly name: string;
  readonly role: string;
}

export interface FixtureClosing {
  readonly review: string;
  readonly learn: string;
  readonly answer: string;
}

export interface SliceFixture {
  readonly utterances: readonly FixtureUtterance[];
  readonly questions: readonly FixtureQuestion[];
  readonly suggestions: readonly FixtureSuggestion[];
  readonly changes: readonly FixtureChange[];
  readonly recaps: readonly FixtureRecap[];
  readonly gaps: readonly FixtureGap[];
  readonly participants: readonly FixtureParticipant[];
  readonly closing: FixtureClosing;
  readonly streamEndMs: number;
}

function chunkText(text: string): readonly string[] {
  const words = text.split(" ");
  if (words.length <= 8) return [text];
  const first = words.slice(0, Math.ceil(words.length / 2)).join(" ");
  return [first, text];
}

export interface UtteranceTimeline {
  readonly turnRef: string;
  readonly partials: readonly string[];
  readonly firstPartialMs: number;
  readonly finalMs: number;
}

export function utteranceTimeline(item: FixtureUtterance): UtteranceTimeline {
  const marker = ". No, ";
  const correctionAt = item.text.indexOf(marker);
  const partials =
    correctionAt < 0 ? chunkText(item.text) : [item.text.slice(0, correctionAt + 1), item.text];
  return {
    turnRef: item.id,
    partials,
    firstPartialMs: item.startMs + Math.round((1 / (partials.length + 1)) * item.durationMs),
    finalMs: item.startMs + item.durationMs,
  };
}

export function buildProviderSchedule(
  utterances: readonly FixtureUtterance[],
  speakerName: (speakerKey: string) => string,
): ProviderScheduleItem[] {
  const schedule: ProviderScheduleItem[] = [];
  for (const item of utterances) {
    const timeline = utteranceTimeline(item);
    const turnRef = timeline.turnRef;
    schedule.push({ atMs: item.startMs, event: { type: "turnStarted", turnRef } });
    schedule.push({
      atMs: item.startMs,
      event: { type: "speaker", label: speakerName(item.speakerKey) },
    });
    timeline.partials.forEach((text, index) => {
      schedule.push({
        atMs:
          item.startMs +
          Math.round(((index + 1) / (timeline.partials.length + 1)) * item.durationMs),
        event: { type: "partial", turnRef, text },
      });
    });
    schedule.push({
      atMs: timeline.finalMs,
      event: { type: "completed", turnRef, text: item.text },
    });
    schedule.push({ atMs: timeline.finalMs, event: { type: "turnEnded", turnRef } });
  }
  return schedule.toSorted((a, b) => a.atMs - b.atMs);
}

export interface AuthoredSchedules {
  readonly transcripts: AuthoredTranscript[];
  readonly translations: TranslationIntent[];
  readonly intelligence: IntelligenceEvent[];
  readonly gapSkips: GapSkip[];
}

export function buildAuthoredSchedules(fixture: SliceFixture): AuthoredSchedules {
  const transcripts: AuthoredTranscript[] = fixture.gaps.map((gap) => ({
    atMs: gap.atMs,
    event: {
      type: "discontinuity",
      reason: gap.reason,
      detail: `authored replay: ${gap.detail} Not STT output.`,
    } as const,
  }));
  const translations: TranslationIntent[] = [];
  for (const item of fixture.utterances) {
    if (item.translationText === undefined) continue;
    const timeline = utteranceTimeline(item);
    const atMs = Math.max(timeline.finalMs, item.translationAtMs ?? timeline.finalMs);
    translations.push({ atMs, turnRef: item.id, text: item.translationText });
  }
  const intelligence: IntelligenceEvent[] = [
    {
      type: "participants-announced",
      atMs: 0,
      roster: fixture.participants.map((item) => ({
        speakerKey: item.speakerKey,
        name: item.name,
        role: item.role,
      })),
    },
  ];
  for (const item of fixture.utterances) {
    intelligence.push({
      type: "utterance-annotated",
      atMs: utteranceTimeline(item).firstPartialMs,
      turnRef: item.id,
      ...(item.vocab === undefined ? {} : { vocab: item.vocab }),
      ...(item.intent === undefined ? {} : { intent: item.intent }),
      expectsTranslation: item.expectsTranslation,
    });
  }
  const byQuestion = new Map(fixture.suggestions.map((item) => [item.questionId, item]));
  for (const item of fixture.questions) {
    intelligence.push({
      type: "question-asked",
      atMs: item.atMs,
      questionId: item.id,
      text: item.text,
      meaning: item.meaning,
      addressee: item.addressee,
      evidence: [...item.evidence],
    });
    const suggestion = byQuestion.get(item.id);
    if (suggestion === undefined) {
      intelligence.push({
        type: "suggestion-absent",
        atMs: item.atMs,
        questionId: item.id,
        holdingEn: "May I confirm the meaning and the evidence before answering?",
        holdingId: "Boleh saya konfirmasi dulu maksud dan datanya sebelum menjawab?",
      });
    } else {
      intelligence.push({
        type: "suggestion-pending",
        atMs: item.atMs,
        questionId: item.id,
        holdingEn: suggestion.holdingEn,
        holdingId: suggestion.holdingId,
      });
      intelligence.push({
        type: "suggestion-ready",
        atMs: suggestion.suggestAtMs,
        questionId: item.id,
        generation: 0,
        draftEn: suggestion.draftEn,
        draftId: suggestion.draftId,
      });
    }
  }
  for (const item of fixture.changes) {
    for (const affected of item.affects) {
      intelligence.push({
        type: "assumption-changed",
        atMs: item.atMs,
        questionId: affected,
        text: item.text,
        invalidates: item.invalidates,
      });
    }
  }
  for (const item of fixture.recaps) {
    intelligence.push({
      type: "recap-available",
      atMs: item.atMs,
      fromMs: item.fromMs,
      throughMs: item.throughMs,
      text: item.text,
      evidence: [...item.evidence],
    });
  }
  intelligence.push({
    type: "meeting-closed",
    atMs: fixture.streamEndMs,
    review: fixture.closing.review,
    learn: fixture.closing.learn,
    answer: fixture.closing.answer,
  });
  intelligence.sort((a, b) => a.atMs - b.atMs);
  translations.sort((a, b) => a.atMs - b.atMs);
  return {
    transcripts,
    translations,
    intelligence,
    gapSkips: fixture.gaps.map((gap) => ({ atMs: gap.atMs, skip: gap.skipSeq })),
  };
}

export class TurnRegistry {
  private readonly turnToKey = new Map<string, string>();
  private readonly keyToTurn = new Map<string, string>();

  observeAccepted(event: TranscriptEvent, source: SpeechProviderEvent): void {
    if (event.type !== "partial" && event.type !== "final") return;
    if (this.keyToTurn.has(event.utteranceId)) return;
    const turnRef = sourceTurnRef(source);
    if (turnRef === undefined) return;
    this.turnToKey.set(turnRef, event.utteranceId);
    this.keyToTurn.set(event.utteranceId, turnRef);
  }

  resolveTurnRef(turnRef: string): string | undefined {
    return this.turnToKey.get(turnRef);
  }

  turnRefFor(utteranceId: string): string | undefined {
    return this.keyToTurn.get(utteranceId);
  }
}

function sourceTurnRef(source: SpeechProviderEvent): string | undefined {
  if (source.type === "partial") return source.turnRef;
  if (source.type === "completed") return source.turnRef;
  return undefined;
}
