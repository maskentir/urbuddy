import type { DomainState } from "./projection.js";

export type View = "live" | "context" | "respond" | "closed";

export interface UserState {
  readonly view: View;
  readonly question: string | undefined;
  readonly revealedHistory: boolean;
  readonly editing: boolean;
  readonly text: string;
  readonly noteAtMs: number | undefined;
  readonly original: boolean;
  readonly showAnswer: boolean;
  readonly help: boolean;
  readonly understoodKey: string | undefined;
  readonly understoodAtMs: number | undefined;
  readonly lastViewedKey: string | undefined;
  readonly contextSel: string | undefined;
  readonly guidanceDismissed: boolean;
  readonly scroll: number;
}

export interface Session {
  readonly domain: DomainState;
  readonly user: UserState;
  readonly atMs: number;
  readonly running: boolean;
  readonly assistanceEnabled?: boolean;
}

export function initialSession(domain: DomainState): Session {
  return {
    domain,
    user: {
      view: "live",
      question: undefined,
      revealedHistory: false,
      editing: false,
      text: "",
      noteAtMs: undefined,
      original: false,
      showAnswer: false,
      help: false,
      understoodKey: undefined,
      understoodAtMs: undefined,
      lastViewedKey: undefined,
      contextSel: undefined,
      guidanceDismissed: false,
      scroll: 0,
    },
    atMs: 0,
    running: false,
  };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function segments(text: string): string[] {
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

export function latestQuestionId(session: Session): string | undefined {
  return session.domain.questionOrder[session.domain.questionOrder.length - 1];
}

export function touchLiveView(session: Session): Session {
  if (session.user.view !== "live") return session;
  const recent = session.domain.utterances[session.domain.utterances.length - 1];
  if (recent === undefined || recent.key === session.user.lastViewedKey) return session;
  return { ...session, user: { ...session.user, lastViewedKey: recent.key } };
}

export function actUser(session: Session, key: string, clockMs: number): Session {
  const user = session.user;
  if (key === "esc") {
    return {
      ...session,
      user: {
        ...user,
        view: session.domain.streamEnded ? "closed" : "live",
        editing: false,
        help: false,
      },
    };
  }
  if (user.editing) {
    if (key === "enter") {
      if (user.text.length === 0) return { ...session, user: { ...user, editing: false } };
      return { ...session, user: { ...user, editing: false, noteAtMs: clockMs } };
    }
    if (key === "backspace") {
      return { ...session, user: { ...user, text: segments(user.text).slice(0, -1).join("") } };
    }
    if (!key.startsWith("input:")) return session;
    const next = (user.text + key.slice(6)).normalize("NFC");
    return { ...session, user: { ...user, text: segments(next).slice(0, 200).join("") } };
  }
  switch (key) {
    case "?":
      return { ...session, user: { ...user, help: !user.help } };
    case "c": {
      if (user.view === "closed") return session;
      const first = session.domain.recapResolvedKeys[0];
      return {
        ...session,
        user: {
          ...user,
          view: "context",
          help: false,
          guidanceDismissed: true,
          contextSel: first,
          scroll: 0,
        },
      };
    }
    case "r": {
      if (user.view === "closed") return session;
      return {
        ...session,
        user: {
          ...user,
          view: "respond",
          help: false,
          guidanceDismissed: true,
          question: user.question ?? latestQuestionId(session),
          revealedHistory: false,
          scroll: 0,
        },
      };
    }
    case "m": {
      if (user.view !== "live" && user.view !== "context") return session;
      const key =
        user.view === "live"
          ? session.domain.utterances[session.domain.utterances.length - 1]?.key
          : user.contextSel;
      if (key === undefined) return session;
      return { ...session, user: { ...user, understoodKey: key, understoodAtMs: clockMs } };
    }
    case "o":
      return { ...session, user: { ...user, original: !user.original } };
    case "n":
      if (user.view !== "respond") return session;
      return {
        ...session,
        user: { ...user, question: latestQuestionId(session), revealedHistory: false },
      };
    case "u":
      return user.view === "respond"
        ? { ...session, user: { ...user, revealedHistory: !user.revealedHistory } }
        : session;
    case "x":
      if (user.view !== "respond") return session;
      return { ...session, user: { ...user, editing: true } };
    case "a":
      return user.view === "closed"
        ? { ...session, user: { ...user, showAnswer: !user.showAnswer } }
        : session;
    case "left":
    case "right": {
      const ids = citedIds(session);
      if (ids.length === 0) return session;
      const position = ids.findIndex((id) => id === user.contextSel);
      if (position < 0) {
        const first = key === "left" ? ids[0] : ids[ids.length - 1];
        return first === undefined ? session : { ...session, user: { ...user, contextSel: first } };
      }
      const next = ids[position + (key === "left" ? -1 : 1)];
      if (next === undefined || next === user.contextSel) return session;
      return { ...session, user: { ...user, contextSel: next } };
    }
    case "up":
    case "down":
      return {
        ...session,
        user: { ...user, scroll: Math.min(40, Math.max(0, user.scroll + (key === "up" ? -1 : 1))) },
      };
    default:
      return session;
  }
}

export function citedIds(session: Session): readonly string[] {
  if (session.user.view === "context") return session.domain.recapResolvedKeys;
  const question =
    session.user.question === undefined
      ? undefined
      : session.domain.questions.get(session.user.question);
  return question?.resolvedEvidence ?? [];
}

export function timeLabel(seconds: number): string {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
