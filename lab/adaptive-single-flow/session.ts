import {
  END_AT,
  JOIN_AT,
  changes,
  questions,
  recaps,
  suggestions,
  utterances,
  type Question,
  type Suggestion,
  type Utterance,
} from "./scenario.js";

export type View = "live" | "context" | "respond" | "closed";

export type Lifecycle = "ready" | "pending" | "changed" | "invalidated" | "insufficient";

export interface Session {
  readonly at: number;
  readonly running: boolean;
  readonly replay: boolean;
  readonly view: View;
  readonly question: string | undefined;
  readonly revealedHistory: boolean;
  readonly editing: boolean;
  readonly text: string;
  readonly noteAt: number | undefined;
  readonly original: boolean;
  readonly showAnswer: boolean;
  readonly help: boolean;
  readonly understoodAt: number | undefined;
  readonly lastViewedId: string | undefined;
  readonly contextSel: string | undefined;
  readonly guidanceDismissed: boolean;
  readonly scroll: number;
}

export function visibleUtterances(at: number): readonly Utterance[] {
  return utterances.filter((item) => item.at >= JOIN_AT && item.at <= at);
}

export function utteranceById(id: string): Utterance | undefined {
  return utterances.find((item) => item.id === id);
}

export function translationState(item: Utterance, at: number): "translated" | "pending" | "none" {
  if (item.translation === undefined) return "none";
  if (item.translationAt !== undefined && item.translationAt > at) return "pending";
  return "translated";
}

export function questionById(id: string): Question | undefined {
  return questions.find((item) => item.id === id);
}

export function latestQuestionId(at: number): string | undefined {
  return questions.findLast((item) => item.at <= at)?.id;
}

export function suggestionFor(questionId: string): Suggestion | undefined {
  return suggestions.find((item) => item.questionId === questionId);
}

export function lifecycle(questionId: string, at: number): Lifecycle {
  const question = questionById(questionId);
  if (question === undefined) return "insufficient";
  const suggestion = suggestionFor(questionId);
  if (suggestion === undefined) return "insufficient";
  const invalidated = changes.some(
    (change) =>
      change.invalidates &&
      change.at <= at &&
      change.at > question.at &&
      change.affects.includes(questionId),
  );
  if (invalidated) return "invalidated";
  if (at < suggestion.suggestAt) return "pending";
  const changed = changes.some(
    (change) =>
      !change.invalidates &&
      change.at <= at &&
      change.at > Math.max(question.at, suggestion.suggestAt) &&
      change.affects.includes(questionId),
  );
  return changed ? "changed" : "ready";
}

export function lifecycleChanges(questionId: string, at: number): readonly string[] {
  const question = questionById(questionId);
  if (question === undefined) return [];
  return changes
    .filter((change) => change.at <= at && change.at > question.at)
    .filter((change) => change.affects.includes(questionId))
    .map((change) => change.text);
}

export function noteFlagged(state: Session): boolean {
  const selected = state.question;
  if (selected === undefined || state.noteAt === undefined) return false;
  const writtenAt = state.noteAt;
  return changes.some(
    (change) => change.at > writtenAt && change.at <= state.at && change.affects.includes(selected),
  );
}

export function citedIds(state: Session): readonly string[] {
  if (state.view === "context") return recapFor(state.at)?.evidence ?? [];
  const question = state.question === undefined ? undefined : questionById(state.question);
  return question?.evidence ?? [];
}

export function recapFor(at: number): (typeof recaps)[number] | undefined {
  return recaps.findLast((item) => item.at <= at);
}

export function initial(at: number, replay = false): Session {
  const recent = visibleUtterances(at).at(-1);
  return {
    at,
    running: false,
    replay,
    view: at >= END_AT ? "closed" : "live",
    question: undefined,
    revealedHistory: false,
    editing: false,
    text: "",
    noteAt: undefined,
    original: false,
    showAnswer: false,
    help: false,
    understoodAt: undefined,
    lastViewedId: recent?.id,
    contextSel: undefined,
    guidanceDismissed: false,
    scroll: 0,
  };
}

export function advance(state: Session, at: number, running = state.running): Session {
  const next = Math.min(at, END_AT);
  const recent = visibleUtterances(next).at(-1);
  const recapped = recaps.findLast((item) => item.at <= next)?.evidence;
  const contextSel =
    state.view === "context" && recapped !== undefined
      ? recapped.includes(state.contextSel ?? "")
        ? state.contextSel
        : recapped[0]
      : state.contextSel;
  return {
    ...state,
    at: next,
    running: running && next < END_AT,
    view: next >= END_AT ? "closed" : state.view === "closed" ? "live" : state.view,
    lastViewedId: state.view === "live" ? (recent?.id ?? state.lastViewedId) : state.lastViewedId,
    contextSel,
  };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function segments(text: string): string[] {
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

export function act(state: Session, key: string): Session {
  if (key === "esc") {
    return { ...state, view: state.at >= END_AT ? "closed" : "live", editing: false, help: false };
  }
  if (state.editing) {
    if (key === "enter") {
      return state.text.length === 0
        ? { ...state, editing: false }
        : { ...state, editing: false, noteAt: state.at };
    }
    if (key === "backspace") return { ...state, text: segments(state.text).slice(0, -1).join("") };
    if (!key.startsWith("input:")) return state;
    const next = (state.text + key.slice(6)).normalize("NFC");
    return { ...state, text: segments(next).slice(0, 200).join("") };
  }
  switch (key) {
    case "?":
      return { ...state, help: !state.help };
    case "c":
      if (state.view === "closed") return state;
      return {
        ...state,
        view: "context",
        help: false,
        guidanceDismissed: true,
        contextSel: recapFor(state.at)?.evidence[0],
        scroll: 0,
      };
    case "r": {
      if (state.view === "closed") return state;
      const latest = latestQuestionId(state.at);
      return {
        ...state,
        view: "respond",
        help: false,
        guidanceDismissed: true,
        question: state.question ?? latest,
        revealedHistory: false,
        scroll: 0,
      };
    }
    case "m": {
      if (state.view !== "live" && state.view !== "context") return state;
      const source =
        state.view === "live"
          ? visibleUtterances(state.at).at(-1)
          : utteranceById(state.contextSel ?? "");
      return source === undefined ? state : { ...state, understoodAt: source.at };
    }
    case "o":
      return { ...state, original: !state.original };
    case "n":
      if (state.view !== "respond") return state;
      return { ...state, question: latestQuestionId(state.at), revealedHistory: false };
    case "u":
      return state.view === "respond"
        ? { ...state, revealedHistory: !state.revealedHistory }
        : state;
    case "x":
      if (state.view !== "respond") return state;
      return { ...state, editing: true };
    case "a":
      return state.view === "closed" ? { ...state, showAnswer: !state.showAnswer } : state;
    case "left":
    case "right": {
      const ids = citedIds(state);
      if (ids.length === 0) return state;
      const position = ids.findIndex((id) => id === state.contextSel);
      const next =
        position < 0
          ? key === "left"
            ? ids[0]
            : ids[ids.length - 1]
          : ids[Math.min(ids.length - 1, Math.max(0, position + (key === "left" ? -1 : 1)))];
      return next === undefined || next === state.contextSel
        ? state
        : { ...state, contextSel: next };
    }
    case "up":
    case "down":
      return {
        ...state,
        scroll: Math.min(40, Math.max(0, state.scroll + (key === "up" ? -1 : 1))),
      };
    case " ":
    case ".":
    case "]":
      return state.replay ? transport(state, key) : state;
    default:
      return state;
  }
}

function transport(state: Session, key: string): Session {
  if (key === " ") return { ...state, running: !state.running && state.at < END_AT };
  if (key === ".") {
    const times = Array.from(
      new Set([...utterances.map((item) => item.at), ...changes.map((item) => item.at), END_AT]),
    ).toSorted((a, b) => a - b);
    return advance(state, times.find((at) => at > state.at) ?? END_AT, false);
  }
  return advance(state, END_AT, false);
}

export function timeLabel(seconds: number): string {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
