import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { type JSX, useEffect, useState } from "react";

import {
  activeCard,
  type Card,
  END_AT,
  JOIN_AT,
  replayAt,
  type SourceRow,
  timeLabel,
} from "./model.js";
import { cards, chapters, events, participants } from "./scenario.js";

export const concepts = ["companion", "workspace", "attention"] as const;
export type Concept = (typeof concepts)[number];

const names = {
  companion: "Companion",
  workspace: "Adaptive Workspace",
  attention: "Attention-Aware Companion",
} as const;
const paper = "#F4F0DF";
const muted = "#ACA78F";
const acid = "#BAF52E";
const orange = "#FF633B";

type View = "follow" | "history" | "recovery" | "response" | "review" | "learn" | "info" | "help";
export interface LabState {
  readonly at: number;
  readonly running: boolean;
  readonly view: View;
  readonly anchor?: number;
  readonly selected?: string;
  readonly pinned?: string;
  readonly draftAt?: number | undefined;
  readonly answer?: boolean;
  readonly historyAt?: number;
  readonly evidence?: readonly string[];
}

const views: Partial<Record<string, View>> = {
  f: "follow",
  h: "history",
  c: "recovery",
  r: "response",
  v: "review",
  l: "learn",
  i: "info",
  "?": "help",
};

export function initialState(at: number, running = false): LabState {
  return { at, running, view: "follow" };
}

function cardFor(view: View, at: number): Card | undefined {
  if (view !== "recovery" && view !== "response" && view !== "review" && view !== "learn") return;
  const card = activeCard(cards, view, at);
  const chapter = chapters.findLast((item) => item.at <= at);
  return view === "response" && card && card.at < (chapter?.at ?? 0) ? undefined : card;
}

const eventTimes = Array.from(new Set(events.map(({ at }) => at)));
type Replay = ReturnType<typeof replayAt>;

export function press(state: LabState, key: string, replay = replayAt(events, state.at)): LabState {
  const view = views[key];
  if (view) {
    const selected = replay.rows.at(-1)?.speech.id;
    return {
      ...state,
      view,
      draftAt: undefined,
      answer: false,
      ...((view === "history" || view === "recovery" || view === "response") &&
      state.view === "follow"
        ? { anchor: state.anchor ?? state.at }
        : {}),
      ...(view === "history" && selected ? { selected, historyAt: state.at, evidence: [] } : {}),
    };
  }
  if (key === " ") return { ...state, running: state.at < END_AT && !state.running };
  if (key === "n" || key === ".") {
    const next =
      key === "n"
        ? chapters.find(({ at }) => at > state.at)?.at
        : eventTimes.find((at) => at > state.at);
    return { ...state, at: next ?? END_AT, running: false };
  }
  if (key === "m") return { ...state, anchor: state.at };
  if (key === "d" && state.view === "response") {
    const card = cardFor(state.view, state.at);
    return card ? { ...state, draftAt: state.draftAt === card.at ? undefined : card.at } : state;
  }
  if (key === "a" && state.view === "learn") return { ...state, answer: !state.answer };
  if (key === "e") {
    const evidence =
      state.view === "history" ? state.evidence : cardFor(state.view, state.at)?.evidence;
    if (!evidence?.length) return state;
    const index =
      state.view === "history" ? evidence.findIndex((id) => id === state.selected) + 1 : 0;
    const selected = evidence[index % evidence.length];
    return selected
      ? { ...state, historyAt: state.at, view: "history", selected, evidence }
      : state;
  }
  if (state.view !== "history") return state;
  if (key === "p" && state.selected) {
    if (state.pinned === state.selected) {
      const next = { ...state };
      delete next.pinned;
      return next;
    }
    return { ...state, pinned: state.selected };
  }
  if (key === "up" || key === "down") {
    const index = replay.rows.findIndex(({ speech }) => speech.id === state.selected);
    const next = replay.rows[index + (key === "up" ? -1 : 1)]?.speech.id;
    return next ? { ...state, selected: next } : state;
  }
  return state;
}

function speechName(row: SourceRow): string {
  const known = participants.find(({ id }) => id === row.speech.speaker)?.name;
  return row.speech.speakerUncertain
    ? `${known ?? row.speech.speaker}?`
    : (known ?? row.speech.speaker);
}

function Source({ row, detail = false }: { readonly row: SourceRow; readonly detail?: boolean }) {
  const { speech, translation, supersededBy } = row;
  const label = [
    timeLabel(speech.at),
    speechName(row),
    speech.language.toUpperCase(),
    !speech.final ? "PARTIAL" : undefined,
    speech.overlap ? "OVERLAP" : undefined,
    supersededBy ? "SUPERSEDED" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box flexDirection="column" marginBottom={detail ? 1 : 0}>
      <Text color={supersededBy ? orange : muted} bold={detail}>
        {label}
        {detail ? ` · ${speech.id}@${speech.revision}` : ""}
      </Text>
      <Text color={supersededBy ? muted : paper}>{speech.text}</Text>
      {translation?.kind === "translation" && !supersededBy && (
        <Text color={acid}>ID {translation.text}</Text>
      )}
      {translation?.kind === "translation-failed" && !supersededBy && (
        <Text color={orange}>Translation failed · original available</Text>
      )}
      {supersededBy && detail && (
        <Text color={orange}>Updated by {supersededBy} · see current source</Text>
      )}
    </Box>
  );
}

function PaneTitle({ children }: { readonly children: string }): JSX.Element {
  return (
    <Text color={acid} bold>
      {children}
    </Text>
  );
}

function Feed({
  rows,
  limit,
  title,
}: {
  readonly rows: readonly SourceRow[];
  readonly limit: number;
  readonly title: string;
}) {
  return (
    <Box flexDirection="column">
      <PaneTitle>{title}</PaneTitle>
      {rows.length === 0 && <Text color={muted}>Waiting for captured speech.</Text>}
      {rows.slice(-limit).map((row) => (
        <Source key={row.speech.id} row={row} />
      ))}
    </Box>
  );
}

function ScriptedCard({
  card,
  view,
  state,
  rows,
}: {
  readonly card: Card;
  readonly view: "recovery" | "response" | "review" | "learn";
  readonly state: LabState;
  readonly rows: readonly SourceRow[];
}) {
  const draftVisible = state.draftAt === card.at;
  const expanded = (view !== "response" || draftVisible) && (view !== "learn" || state.answer);
  const body = expanded ? card.body : card.body.slice(0, 1);
  const firstRef = rows.find(({ speech }) => speech.id === card.evidence[0]);
  const superseded = card.evidence.some((id) =>
    rows.some((row) => row.speech.id === id && row.supersededBy),
  );
  return (
    <Box flexDirection="column">
      <Text color={muted}>SIMULATED · {timeLabel(card.at)}</Text>
      <Text color={paper} bold>
        {card.title}
      </Text>
      {superseded ? (
        <Text color={orange}>Source changed. Use current transcript or a later review.</Text>
      ) : (
        body.map((line, index) => (
          <Text key={line} color={index === 1 && view === "response" ? acid : paper}>
            {line}
          </Text>
        ))
      )}
      {card.uncertain && <Text color={orange}>Uncertain · {card.uncertain}</Text>}
      {firstRef && (
        <Text color={muted}>
          e Open sources ({card.evidence.length}) · {timeLabel(firstRef.speech.at)}
        </Text>
      )}
      {view === "response" && !superseded && (
        <Text color={acid}>
          {draftVisible ? "Draft only · no message sent" : "d  Reveal response draft"}
        </Text>
      )}
      {view === "learn" && (
        <Text color={acid}>{state.answer ? "a  Hide answer" : "a  Reveal answer"}</Text>
      )}
    </Box>
  );
}

function Panel({
  state,
  replay,
  compact,
}: {
  readonly state: LabState;
  readonly replay: Replay;
  readonly compact: boolean;
}) {
  const { view } = state;
  const { rows } = replay;
  if (view === "follow") {
    return null;
  }
  if (view === "help") {
    return (
      <Box flexDirection="column">
        <PaneTitle>CONTROLS</PaneTitle>
        <Text color={paper}>f Follow · h History · c Catch up · r Respond</Text>
        <Text color={paper}>v Review · l Learn · i Privacy / status</Text>
        <Text color={paper}>m Mark recovery point · ↑↓ Browse history · p Pin</Text>
        <Text color={paper}>Space Play/pause · . Next event · n Next chapter</Text>
        <Text color={paper}>d Draft · a Answer · e Cited sources · q Quit</Text>
        <Text color={muted}>Replay controls do not count toward meeting tasks.</Text>
      </Box>
    );
  }
  if (view === "info") {
    return (
      <Box flexDirection="column">
        <PaneTitle>PRIVACY / STATUS</PaneTitle>
        <Text color={paper}>Capture · synthetic transcript fixture only</Text>
        <Text color={paper}>Sent · nothing, offline replay</Text>
        <Text color={paper}>Saved · nothing, pins are temporary</Text>
        <Text color={muted}>Fixture translation backlog · {replay.pending}</Text>
        {replay.rejected > 0 && (
          <Text color={muted}>Late or incompatible translations hidden · {replay.rejected}</Text>
        )}
        {replay.coverage.map((event) => (
          <Text key={event.at} color={event.kind === "gap" ? orange : muted}>
            {timeLabel(event.at)} {event.kind} · {event.detail}
          </Text>
        ))}
        {replay.coverage.length > 0 && (
          <Text color={orange}>Missing speech remains unknown after reconnect.</Text>
        )}
      </Box>
    );
  }
  if (view === "history") {
    const selected = rows.find(({ speech }) => speech.id === state.selected);
    const newer = rows.filter(({ firstAt }) => firstAt > (state.historyAt ?? state.at)).length;
    return (
      <Box flexDirection="column">
        <PaneTitle>HISTORY · capture continues</PaneTitle>
        <Text color={muted}>{newer} new since opening · ↑↓ Browse · p Pin</Text>
        {selected ? (
          <Source row={selected} detail />
        ) : (
          <Text color={muted}>No captured utterance selected.</Text>
        )}
        {state.evidence && state.evidence.length > 1 && (
          <Text color={muted}>e Next cited source</Text>
        )}
        {state.pinned && <Text color={acid}>TEMPORARY PIN · {state.pinned}</Text>}
      </Box>
    );
  }

  const card = cardFor(view, state.at);
  const titles = {
    recovery: "CATCH UP",
    response: "RESPOND",
    review: "REVIEW",
    learn: "LEARN",
  } as const;
  const anchor = state.anchor ?? JOIN_AT;
  const afterAnchor = rows.filter(({ speech }) => speech.at > anchor);
  const revised = afterAnchor.filter(({ firstAt }) => firstAt <= anchor).length;
  const gaps = replay.coverage.filter(({ at, kind }) => at >= anchor && kind === "gap");
  const pinned = rows.find(({ speech }) => speech.id === state.pinned);
  return (
    <Box flexDirection="column">
      <PaneTitle>{titles[view]}</PaneTitle>
      {view === "recovery" && (
        <>
          <Text color={muted}>
            Recovery point {timeLabel(anchor)} · {afterAnchor.length - revised} new · {revised}{" "}
            revised
          </Text>
          {gaps.length > 0 && (
            <Text color={orange}>{gaps.length} capture gap since recovery point</Text>
          )}
        </>
      )}
      {card ? (
        <ScriptedCard card={card} view={view} state={state} rows={rows} />
      ) : (
        <Text color={muted}>
          {view === "review" || view === "learn"
            ? "Available at meeting closure."
            : "No authored help for this point in the replay."}
        </Text>
      )}
      {view === "recovery" && afterAnchor.length > 0 && (
        <Feed rows={afterAnchor} limit={compact ? 1 : 2} title="LATEST AFTER RECOVERY POINT" />
      )}
      {view === "review" && pinned && (
        <Text color={pinned.supersededBy ? orange : muted}>
          Temporary pin · {pinned.speech.id}
          {pinned.supersededBy ? " · superseded" : ""}
        </Text>
      )}
    </Box>
  );
}

export function LabScreen({
  concept,
  state,
  columns,
  rows,
}: {
  readonly concept: Concept;
  readonly state: LabState;
  readonly columns: number;
  readonly rows: number;
}) {
  const replay = replayAt(events, state.at);
  const chapter = chapters.findLast(({ at }) => at <= state.at);
  const latestCoverage = replay.coverage.at(-1);
  const capture = replay.closed
    ? "replay complete"
    : state.at < JOIN_AT
      ? "not joined"
      : latestCoverage?.kind === "gap"
        ? "capture gap (fixture)"
        : "source feed active";
  const stacked = columns < 78;
  const condensed = stacked || rows < 26;
  const split = concept === "workspace" && !stacked;
  const showPanel = state.view !== "follow";
  const showLiveStrip = concept === "attention" && state.view === "response" && rows >= 22;
  const limit = concept === "attention" ? 2 : rows < 24 ? 3 : 4;
  const activeMode =
    state.view === "response"
      ? "Respond"
      : state.view === "follow"
        ? "Follow"
        : state.view === "recovery"
          ? "Catch Up"
          : undefined;
  const failed = replay.rows.filter(
    ({ translation, supersededBy }) => translation?.kind === "translation-failed" && !supersededBy,
  ).length;
  return (
    <Box width={columns} flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color={acid} bold>
          SIGNAL RIOT / URBUDDY
        </Text>
        <Text color={paper} bold>
          {names[concept]} · {timeLabel(state.at)} / 30:00
        </Text>
        <Text color={muted} wrap="wrap">
          {chapter?.title} · OFFLINE REPLAY ·{" "}
          {state.at >= END_AT ? "ended" : state.running ? "playing" : "paused"}
        </Text>
        <Text color={latestCoverage?.kind === "gap" || failed > 0 ? orange : muted} wrap="wrap">
          {capture}
          {latestCoverage?.kind === "reconnect" && " · reconnected, coverage incomplete"}
          {replay.pending > 0 && ` · ID backlog ${replay.pending}`}
          {failed > 0 && ` · ID failed ${failed}`}
        </Text>
      </Box>
      {concept === "attention" && activeMode && (
        <Text color={muted}>
          Mode ·{" "}
          <Text color={acid} bold>
            {activeMode}
          </Text>
          {state.anchor !== undefined && ` · recovery point ${timeLabel(state.anchor)}`}
        </Text>
      )}
      {split ? (
        <Box gap={1} alignItems="flex-start">
          <Box width={showPanel ? "50%" : "61%"} flexDirection="column" flexShrink={0}>
            <Feed rows={replay.rows} limit={limit} title="CURRENT TRANSCRIPT" />
          </Box>
          <Box
            flexGrow={1}
            flexShrink={1}
            borderStyle="single"
            borderColor={muted}
            paddingX={1}
            flexDirection="column"
          >
            {showPanel ? (
              <Panel state={state} replay={replay} compact={true} />
            ) : (
              <>
                <PaneTitle>CONTEXT PANEL</PaneTitle>
                <Text color={muted}>c Catch up · r Respond</Text>
                <Text color={muted}>h History · i Privacy/status</Text>
              </>
            )}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {!showPanel && (
            <Feed
              rows={replay.rows}
              limit={limit}
              title={concept === "attention" ? "FOLLOW · CURRENT TRANSCRIPT" : "CURRENT TRANSCRIPT"}
            />
          )}
          {showPanel && <Panel state={state} replay={replay} compact={condensed} />}
          {showLiveStrip && replay.rows.at(-1) && (
            <Box marginTop={1} flexDirection="column">
              <PaneTitle>LIVE WHILE YOU PREPARE</PaneTitle>
              <Text color={muted} wrap="truncate-end">
                {replay.rows.at(-1)?.speech.text}
              </Text>
            </Box>
          )}
          {showPanel && concept === "workspace" && state.view === "response" && (
            <Text color={muted}>Compact layout · f to reopen transcript</Text>
          )}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text color={muted} wrap="wrap">
          f Follow · h History · c Catch up · r Respond
        </Text>
        <Text color={muted} wrap="wrap">
          v Review · l Learn · i Status · m Mark · ? Keys
        </Text>
        <Text color={muted} wrap="wrap">
          Space Play · . Step · n Chapter · q Quit
        </Text>
      </Box>
    </Box>
  );
}

export function MeetingLab({
  concept,
  start,
  play,
  speed,
  size,
}: {
  readonly concept: Concept;
  readonly start: number;
  readonly play: boolean;
  readonly speed: number;
  readonly size?: { readonly columns: number; readonly rows: number };
}) {
  const window = useWindowSize();
  const { exit } = useApp();
  const [state, setState] = useState(() => initialState(start, play));
  const { running } = state;
  useEffect(() => {
    if (!running) return;
    let previous = performance.now();
    let remainder = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      remainder += ((now - previous) * speed) / 1000;
      previous = now;
      const seconds = Math.floor(remainder);
      if (seconds === 0) return;
      remainder -= seconds;
      setState((current) => {
        if (!current.running) return current;
        const at = Math.min(END_AT, current.at + seconds);
        return { ...current, at, running: at < END_AT };
      });
    }, 100);
    return () => clearInterval(timer);
  }, [running, speed]);
  useInput((input, key) => {
    if (key.eventType === "release") return;
    if (input === "q") exit();
    else setState((current) => press(current, key.upArrow ? "up" : key.downArrow ? "down" : input));
  });
  return (
    <LabScreen
      concept={concept}
      state={state}
      columns={size?.columns ?? window.columns}
      rows={size?.rows ?? window.rows}
    />
  );
}
