import type { TranslationEvent } from "../../src/modules/language/translation.js";
import type { TranscriptEvent } from "../../src/modules/perception/speech.js";
import type { SessionOutput } from "../../src/modules/session/events.js";

export interface RosterEntry {
  readonly speakerKey: string;
  readonly name: string;
  readonly role: string;
}

export interface ProjectedUtterance {
  readonly key: string;
  readonly turnRef: string;
  speakerKey: string;
  text: string;
  revision: number;
  finalized: boolean;
  readonly firstSeenAtMs: number;
  assists: boolean;
  vocab?: string;
  intent?: string;
  expectsTranslation: boolean;
  translation?: { text: string; revision: number };
}

export type SuggestionStatus = "ready" | "changed" | "invalidated" | "insufficient" | "pending";

export interface ProjectedQuestion {
  readonly id: string;
  readonly text: string;
  readonly meaning: string;
  readonly addressee: string;
  readonly evidenceTurnRefs: readonly string[];
  resolvedEvidence: readonly string[];
  unavailableEvidence: readonly string[];
  generation: number;
  invalidated: boolean;
  invalidatedAtMs?: number;
  changes: readonly string[];
  appliedChangeKeys: string[];
  suggestion?: {
    status: Exclude<SuggestionStatus, "pending" | "insufficient">;
    draftEn: string;
    draftId: string;
  };
  pendingHolding?: { holdingEn: string; holdingId: string };
  insufficient: boolean;
  insufficientHolding?: { holdingEn: string; holdingId: string };
}

export interface RecapState {
  readonly atMs: number;
  readonly fromMs: number;
  readonly throughMs: number;
  readonly text: string;
  readonly evidenceTurnRefs: readonly string[];
}

export type IntelligenceEvent =
  | { type: "participants-announced"; atMs: number; roster: readonly RosterEntry[] }
  | {
      type: "question-asked";
      atMs: number;
      questionId: string;
      text: string;
      meaning: string;
      addressee: string;
      evidence: readonly string[];
    }
  | {
      type: "suggestion-pending";
      atMs: number;
      questionId: string;
      holdingEn: string;
      holdingId: string;
    }
  | {
      type: "suggestion-ready";
      atMs: number;
      questionId: string;
      generation: number;
      draftEn: string;
      draftId: string;
    }
  | {
      type: "suggestion-absent";
      atMs: number;
      questionId: string;
      holdingEn: string;
      holdingId: string;
    }
  | {
      type: "assumption-changed";
      atMs: number;
      questionId: string;
      text: string;
      invalidates: boolean;
    }
  | {
      type: "recap-available";
      atMs: number;
      fromMs: number;
      throughMs: number;
      text: string;
      evidence: readonly string[];
    }
  | {
      type: "utterance-annotated";
      atMs: number;
      turnRef: string;
      vocab?: string;
      intent?: string;
      expectsTranslation: boolean;
    }
  | { type: "meeting-closed"; atMs: number; review: string; learn: string; answer: string };

export interface Rejection {
  readonly kind: string;
  readonly reason: string;
}

export interface DomainState {
  utterances: ProjectedUtterance[];
  byKey: Map<string, ProjectedUtterance>;
  roster: RosterEntry[];
  gaps: Array<{ fromSeq: number; toSeq: number }>;
  gapDetails: string[];
  recapResolvedKeys: readonly string[];
  questions: Map<string, ProjectedQuestion>;
  questionOrder: string[];
  recap?: RecapState;
  translationsRejected: number;
  duplicates: number;
  stale: number;
  closed?: { review: string; learn: string; answer: string };
  streamEnded: boolean;
  rejected: Rejection[];
}

export function createDomain(): DomainState {
  return {
    utterances: [],
    byKey: new Map(),
    roster: [],
    gaps: [],
    gapDetails: [],
    recapResolvedKeys: [],
    questions: new Map(),
    questionOrder: [],
    translationsRejected: 0,
    duplicates: 0,
    stale: 0,
    streamEnded: false,
    rejected: [],
  };
}

export function evidenceLabels(domain: DomainState, keys: readonly string[]): string[] {
  return keys.map((key) => domain.byKey.get(key)?.turnRef ?? key);
}

export function questionStatus(question: ProjectedQuestion): SuggestionStatus {
  if (question.suggestion === undefined) {
    return question.insufficient ? "insufficient" : "pending";
  }
  if (question.invalidated) return "invalidated";
  return question.changes.length > 0 ? "changed" : "ready";
}

export function applySessionOutput(state: DomainState, output: SessionOutput): void {
  switch (output.type) {
    case "applied": {
      const existing = state.byKey.get(output.utteranceId);
      if (existing === undefined) return;
      existing.text = output.text;
      existing.revision = output.revision;
      if (output.kind === "final") existing.finalized = true;
      return;
    }
    case "duplicate":
      state.duplicates += 1;
      return;
    case "stale":
      state.stale += 1;
      return;
    case "gap":
      state.gaps.push({ fromSeq: output.from, toSeq: output.to });
      return;
    case "completed":
      state.streamEnded = true;
      return;
  }
}

export function registerUtterance(
  state: DomainState,
  key: string,
  turnRef: string,
  speakerKey: string,
  atMs: number,
): void {
  if (state.byKey.has(key)) return;
  const row: ProjectedUtterance = {
    key,
    turnRef,
    speakerKey,
    text: "",
    revision: 0,
    finalized: false,
    firstSeenAtMs: atMs,
    assists: false,
    expectsTranslation: false,
  };
  state.byKey.set(key, row);
  state.utterances.push(row);
}

export function applyTranscriptDetail(state: DomainState, event: TranscriptEvent): void {
  if (event.type !== "discontinuity") return;
  state.gapDetails.push(event.detail);
}

export function applyTranslation(state: DomainState, event: TranslationEvent): void {
  if (event.type !== "committed") {
    state.rejected.push({
      kind: "translation",
      reason: `unsupported translation event ${event.type}`,
    });
    return;
  }
  const target = state.byKey.get(event.sourceUtteranceId);
  if (target === undefined) {
    state.translationsRejected += 1;
    state.rejected.push({
      kind: "translation",
      reason: `unknown utterance ${event.sourceUtteranceId}`,
    });
    return;
  }
  if (event.sourceRevision < target.revision) {
    state.translationsRejected += 1;
    state.rejected.push({
      kind: "translation",
      reason: `stale revision ${event.sourceRevision} < ${target.revision} for ${event.sourceUtteranceId}`,
    });
    return;
  }
  target.translation = { text: event.text, revision: event.sourceRevision };
}

export function applyIntelligence(
  state: DomainState,
  event: IntelligenceEvent,
  resolveTurnRef: (turnRef: string) => string | undefined,
): void {
  switch (event.type) {
    case "participants-announced": {
      for (const entry of event.roster) {
        if (!state.roster.some((item) => item.speakerKey === entry.speakerKey)) {
          state.roster.push(entry);
        }
      }
      return;
    }
    case "question-asked": {
      if (state.questions.has(event.questionId)) {
        state.duplicates += 1;
        return;
      }
      const resolvedNow = resolveEvidence(state, event.evidence, resolveTurnRef);
      state.questions.set(event.questionId, {
        id: event.questionId,
        text: event.text,
        meaning: event.meaning,
        addressee: event.addressee,
        evidenceTurnRefs: event.evidence,
        resolvedEvidence: resolvedNow.resolved,
        unavailableEvidence: resolvedNow.unavailable,
        generation: 0,
        invalidated: false,
        changes: [],
        appliedChangeKeys: [],
        insufficient: false,
      });
      state.questionOrder.push(event.questionId);
      return;
    }
    case "suggestion-pending": {
      const question = state.questions.get(event.questionId);
      if (question === undefined) {
        state.rejected.push({ kind: "suggestion", reason: `unknown question ${event.questionId}` });
        return;
      }
      if (question.suggestion !== undefined || question.insufficient) return;
      question.pendingHolding = { holdingEn: event.holdingEn, holdingId: event.holdingId };
      return;
    }
    case "suggestion-ready": {
      const question = state.questions.get(event.questionId);
      if (question === undefined) {
        state.rejected.push({ kind: "suggestion", reason: `unknown question ${event.questionId}` });
        return;
      }
      if (event.generation !== question.generation || question.invalidated) {
        state.rejected.push({
          kind: "suggestion",
          reason: `stale generation ${event.generation} for ${event.questionId} (current ${question.generation}, invalidated=${question.invalidated})`,
        });
        return;
      }
      question.suggestion = {
        status: question.changes.length > 0 ? "changed" : "ready",
        draftEn: event.draftEn,
        draftId: event.draftId,
      };
      return;
    }
    case "suggestion-absent": {
      const question = state.questions.get(event.questionId);
      if (question === undefined) {
        state.rejected.push({ kind: "suggestion", reason: `unknown question ${event.questionId}` });
        return;
      }
      if (question.suggestion !== undefined || question.insufficient) return;
      question.insufficient = true;
      question.insufficientHolding = { holdingEn: event.holdingEn, holdingId: event.holdingId };
      return;
    }
    case "assumption-changed": {
      const question = state.questions.get(event.questionId);
      if (question === undefined) {
        state.rejected.push({ kind: "suggestion", reason: `unknown question ${event.questionId}` });
        return;
      }
      const key = `${event.atMs}:${event.text}`;
      if (question.appliedChangeKeys.includes(key)) {
        state.duplicates += 1;
        return;
      }
      question.appliedChangeKeys = [...question.appliedChangeKeys, key];
      question.changes = [...question.changes, event.text];
      if (event.invalidates) {
        question.invalidated = true;
        question.invalidatedAtMs = event.atMs;
        question.generation += 1;
        if (question.suggestion !== undefined) {
          question.suggestion = { ...question.suggestion, status: "invalidated" };
        }
      } else if (question.suggestion !== undefined) {
        question.suggestion = { ...question.suggestion, status: "changed" };
      }
      return;
    }
    case "recap-available": {
      const current = state.recap;
      if (current !== undefined && event.atMs < current.atMs) {
        state.rejected.push({ kind: "recap", reason: `out-of-order recap at ${event.atMs}ms` });
        return;
      }
      state.recap = {
        atMs: event.atMs,
        fromMs: event.fromMs,
        throughMs: event.throughMs,
        text: event.text,
        evidenceTurnRefs: event.evidence,
      };
      state.recapResolvedKeys = resolveEvidence(state, event.evidence, resolveTurnRef).resolved;
      return;
    }
    case "utterance-annotated": {
      const key = resolveTurnRef(event.turnRef);
      const target = key === undefined ? undefined : state.byKey.get(key);
      if (target === undefined) {
        state.rejected.push({ kind: "annotation", reason: `unknown turn ${event.turnRef}` });
        return;
      }
      target.assists = event.vocab !== undefined || event.intent !== undefined;
      if (event.vocab !== undefined) target.vocab = event.vocab;
      if (event.intent !== undefined) target.intent = event.intent;
      target.expectsTranslation = event.expectsTranslation;
      return;
    }
    case "meeting-closed": {
      state.closed = { review: event.review, learn: event.learn, answer: event.answer };
      return;
    }
  }
}

export function resolveEvidence(
  state: DomainState,
  turnRefs: readonly string[],
  resolveTurnRef: (turnRef: string) => string | undefined,
): { resolved: string[]; unavailable: string[] } {
  const resolved: string[] = [];
  const unavailable: string[] = [];
  for (const turnRef of turnRefs) {
    const key = resolveTurnRef(turnRef);
    if (key !== undefined && state.byKey.has(key)) resolved.push(key);
    else unavailable.push(turnRef);
  }
  return { resolved, unavailable };
}

export function recomputeEvidence(
  state: DomainState,
  resolveTurnRef: (turnRef: string) => string | undefined,
): void {
  for (const question of state.questions.values()) {
    const { resolved, unavailable } = resolveEvidence(
      state,
      question.evidenceTurnRefs,
      resolveTurnRef,
    );
    question.resolvedEvidence = resolved;
    question.unavailableEvidence = unavailable;
  }
  if (state.recap === undefined) {
    state.recapResolvedKeys = [];
    return;
  }
  state.recapResolvedKeys = resolveEvidence(
    state,
    state.recap.evidenceTurnRefs,
    resolveTurnRef,
  ).resolved;
}
