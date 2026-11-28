export interface Participant {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly accent: string;
}

export interface Chapter {
  readonly at: number;
  readonly title: string;
  readonly task: string;
}

type Timed = { readonly at: number };

export type Utterance = Timed & {
  readonly kind: "utterance";
  readonly id: string;
  readonly speaker: string;
  readonly text: string;
  readonly language: "en" | "id" | "mixed";
  readonly final: boolean;
  readonly revision: number;
  readonly overlap?: boolean;
  readonly speakerUncertain?: boolean;
  readonly supersedes?: readonly string[];
};

type Translation = Timed & { readonly sourceId: string; readonly revision: number } & (
    | { readonly kind: "translation"; readonly text: string }
    | { readonly kind: "translation-failed" }
  );

export type MeetingEvent =
  | Utterance
  | Translation
  | (Timed & { readonly kind: "gap" | "reconnect"; readonly detail: string })
  | (Timed & { readonly kind: "queue"; readonly pending: number })
  | (Timed & { readonly kind: "close" });

export type Card = Timed & {
  readonly kind: "recovery" | "response" | "review" | "learn";
  readonly title: string;
  readonly body: readonly string[];
  readonly evidence: readonly string[];
  readonly uncertain?: string;
  readonly supersedes?: string;
};

export const JOIN_AT = 180;
export const END_AT = 1_800;

export interface SourceRow {
  readonly speech: Utterance;
  readonly firstAt: number;
  readonly translation?: Translation;
  readonly supersededBy?: string;
}

type CoverageEvent = Extract<MeetingEvent, { kind: "gap" | "reconnect" }>;

export function replayAt(events: readonly MeetingEvent[], at: number) {
  const rows = new Map<string, SourceRow>();
  const coverage: CoverageEvent[] = [];
  let pending = 0;
  let closed = false;
  let rejected = 0;
  for (const event of events) {
    if (event.at > at) break;
    if (event.at < JOIN_AT) continue;
    switch (event.kind) {
      case "utterance": {
        const old = rows.get(event.id);
        if (old && (old.speech.final || event.revision <= old.speech.revision)) break;
        rows.set(event.id, {
          speech: event,
          firstAt: old?.firstAt ?? event.at,
        });
        if (event.final) {
          for (const id of event.supersedes ?? []) {
            const prior = rows.get(id);
            if (prior?.speech.final) rows.set(id, { ...prior, supersededBy: event.id });
          }
        }
        break;
      }
      case "translation":
      case "translation-failed": {
        const row = rows.get(event.sourceId);
        if (!row?.speech.final || row.speech.revision !== event.revision || row.supersededBy) {
          rejected += 1;
          break;
        }
        rows.set(event.sourceId, { ...row, translation: event });
        break;
      }
      case "gap":
      case "reconnect":
        coverage.push(event);
        break;
      case "queue":
        pending = event.pending;
        break;
      case "close":
        closed = true;
        break;
    }
  }
  return { rows: Array.from(rows.values()), coverage, pending, closed, rejected };
}

export function activeCard(
  cards: readonly Card[],
  kind: Card["kind"],
  at: number,
): Card | undefined {
  return cards.findLast((card) => card.kind === kind && card.at <= at);
}

export function timeLabel(seconds: number): string {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
