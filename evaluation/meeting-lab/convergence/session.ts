import { END_AT, replayAt, type SourceRow } from "../model.js";
import { chapters } from "../scenario.js";

import { answers, changes, events, recaps, requested } from "./scenario.js";

export type Language = "id" | "en";
export interface Roles {
  readonly comprehension: Language;
  readonly reply: Language;
}
export const DEFAULT_ROLES: Roles = { comprehension: "id", reply: "en" };
export const HISTORY_LIMIT = 12;
export const LIVE_LIMIT = 3;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const times = Array.from(new Set([...events, ...answers, ...recaps].map(({ at }) => at))).sort(
  (a, b) => a - b,
);
export type View =
  | "follow"
  | "history"
  | "translations"
  | "catchup"
  | "respond"
  | "evidence"
  | "review"
  | "learn"
  | "keys";
type Mark = { readonly id: string; readonly at: number };

export interface Session {
  readonly at: number;
  readonly running: boolean;
  readonly view: View;
  readonly selected: string | undefined;
  readonly lastViewed: Mark | undefined;
  readonly understood: Mark | undefined;
  readonly question: string | undefined;
  readonly selectionError: string | undefined;
  readonly recapEvidence: readonly string[] | undefined;
  readonly revealed: boolean;
  readonly editing: boolean;
  readonly text: string;
  readonly wide: boolean;
  readonly original: boolean;
  readonly showStatus: boolean;
  readonly showAnswer: boolean;
  readonly scroll: number;
}

export function sceneAt(at: number) {
  const { rows, coverage, pending, closed } = replayAt(events, at);
  const retained = rows.slice(-HISTORY_LIMIT);
  const recent = retained.slice(-LIVE_LIMIT).toReversed();
  const olderTranslations = retained
    .slice(0, -LIVE_LIMIT)
    .filter(({ translation, supersededBy }) => translation?.kind === "translation" && !supersededBy)
    .toSorted((a, b) => (a.translation?.at ?? 0) - (b.translation?.at ?? 0));
  return {
    retained,
    recent,
    olderTranslations,
    coverage,
    pending,
    closed,
    failed: rows.some(({ translation }) => translation?.kind === "translation-failed"),
  };
}

export function responseFor(state: Session) {
  return answers.find((answer) => answer.id === state.question && answer.at <= state.at);
}

export function newContext(state: Session) {
  const answer = responseFor(state);
  return changes.filter(
    (change) =>
      change.at <= state.at &&
      change.at > (answer?.at ?? state.at) &&
      change.affects.some((id) => id === answer?.id),
  );
}

export function evidenceIds(state: Session): readonly string[] {
  return Array.from(
    new Set([...(responseFor(state)?.evidence ?? []), ...newContext(state).map(({ id }) => id)]),
  );
}

export const citedIds = (state: Session): readonly string[] =>
  state.recapEvidence ?? evidenceIds(state);

export type TranslationStatus = "translated" | "pending" | "unavailable" | "unknown";
export function translationStatus(row: SourceRow): TranslationStatus {
  if (row.supersededBy || row.translation?.kind === "translation-failed") return "unavailable";
  if (row.translation?.kind === "translation") return "translated";
  if (row.speech.final && requested.has(row.speech.id)) return "pending";
  return "unknown";
}

function mark(row: SourceRow | undefined): Mark | undefined {
  return row ? { at: row.speech.at, id: row.speech.id } : undefined;
}

export function initial(at: number, wide = false, running = false): Session {
  return {
    at,
    running: running && at < END_AT,
    view: "follow",
    selected: undefined,
    understood: undefined,
    lastViewed: mark(sceneAt(at).recent[0]),
    question: undefined,
    selectionError: undefined,
    recapEvidence: undefined,
    revealed: false,
    editing: false,
    text: "",
    wide,
    original: false,
    showStatus: false,
    showAnswer: false,
    scroll: 0,
  };
}

export function advance(state: Session, at: number, running = state.running): Session {
  const next = Math.min(at, END_AT);
  return {
    ...state,
    at: next,
    running: running && next < END_AT,
    lastViewed:
      state.view === "follow"
        ? (mark(sceneAt(next).recent[0]) ?? state.lastViewed)
        : state.lastViewed,
  };
}

function open(state: Session, view: View): Session {
  return { ...state, view, editing: false, scroll: 0 };
}

function browse(
  state: Session,
  view: "history" | "translations" | "evidence",
  id: string | undefined,
): Session {
  const source = sceneAt(state.at).retained.find(({ speech }) => speech.id === id);
  return { ...open(state, view), selected: id, lastViewed: mark(source) ?? state.lastViewed };
}

function selectQuestion(state: Session, id: string | undefined): Session {
  const next = open(state, "respond");
  const available = answers.find((answer) => answer.id === id && answer.at <= state.at);
  if (!available) return { ...next, selectionError: id ?? "" };
  if (id === state.question) return { ...next, selectionError: undefined };
  return { ...next, question: id, selectionError: undefined, text: "", revealed: false };
}

export function act(state: Session, key: string): Session {
  const scene = sceneAt(state.at);
  const answer = responseFor(state);
  const latestQuestion = answers.findLast((item) => item.at <= state.at);
  if (key === "esc" || (key === "f" && !state.editing)) {
    return { ...open(state, "follow"), lastViewed: mark(scene.recent[0]) ?? state.lastViewed };
  }
  if (state.editing) {
    if (key === "enter") return { ...state, editing: false };
    if (key === "backspace") {
      const parts = Array.from(graphemes.segment(state.text), ({ segment }) => segment);
      return { ...state, text: parts.slice(0, -1).join("") };
    }
    if (!key.startsWith("input:")) return state;
    const text = (state.text + key.slice(6).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "")).normalize("NFC");
    return {
      ...state,
      text: Array.from(graphemes.segment(text), ({ segment }) => segment)
        .slice(0, 320)
        .join(""),
    };
  }
  switch (key) {
    case " ":
      return { ...state, running: !state.running && state.at < END_AT };
    case ".":
      return advance(state, times.find((at) => at > state.at) ?? END_AT, false);
    case "]":
      return advance(state, chapters.find(({ at }) => at > state.at)?.at ?? END_AT, false);
    case "c":
      return open(state, "catchup");
    case "v":
      return open(state, "review");
    case "l":
      return { ...open(state, "learn"), showAnswer: false };
    case "?":
      return open(state, "keys");
    case "a":
      return state.view === "learn" ? { ...state, showAnswer: !state.showAnswer } : state;
    case "h":
      return browse(state, "history", scene.recent[0]?.speech.id);
    case "t":
      return browse(state, "translations", scene.olderTranslations.at(-1)?.speech.id);
    case "r":
      return selectQuestion(
        state,
        state.view === "history" || state.view === "translations"
          ? state.selected
          : (state.question ?? latestQuestion?.id),
      );
    case "n":
      return state.view === "respond" ? selectQuestion(state, latestQuestion?.id) : state;
    case "e": {
      if (state.view === "catchup") {
        const ids = recaps.findLast((recap) => recap.at <= state.at)?.evidence;
        return ids?.length ? { ...browse(state, "evidence", ids[0]), recapEvidence: ids } : state;
      }
      return state.view === "respond" && state.selectionError === undefined && answer
        ? { ...browse(state, "evidence", evidenceIds(state)[0]), recapEvidence: undefined }
        : state;
    }
    case "d":
      return state.view === "respond" && state.selectionError === undefined && answer?.response
        ? { ...state, revealed: !state.revealed, scroll: 0 }
        : state;
    case "x":
      return state.view === "respond" && state.selectionError === undefined && answer?.response
        ? { ...state, editing: true, scroll: 0 }
        : state;
    case "m": {
      const source =
        state.view === "follow"
          ? scene.recent[0]
          : scene.retained.find(({ speech }) => speech.id === state.selected);
      return source && ["follow", "history", "translations", "evidence"].includes(state.view)
        ? { ...state, understood: mark(source) }
        : state;
    }
    case "o":
      return { ...state, original: !state.original, scroll: 0 };
    case "w":
      return { ...state, wide: !state.wide };
    case "i":
      return { ...state, showStatus: !state.showStatus };
    case "up":
    case "down":
      return {
        ...state,
        scroll: Math.min(350, Math.max(0, state.scroll + (key === "up" ? -1 : 1))),
      };
    case "left":
    case "right": {
      if (state.view !== "history" && state.view !== "translations" && state.view !== "evidence")
        return state;
      const ids =
        state.view === "evidence"
          ? citedIds(state)
          : (state.view === "translations" ? scene.olderTranslations : scene.retained).map(
              ({ speech }) => speech.id,
            );
      const position = ids.findIndex((id) => id === state.selected);
      const next =
        position < 0
          ? ids[key === "left" ? 0 : ids.length - 1]
          : ids[position + (key === "left" ? -1 : 1)];
      return next ? browse(state, state.view, next) : state;
    }
    default:
      return state;
  }
}
