import type { Caption, CaptionSnapshot } from "@modules/session/captions";
import { stripFormatting } from "@platform/output";
import { Box, Text, render, useInput, useWindowSize } from "ink";
import type { JSX } from "react";

const MAX_TEXT = 160;

export interface TerminalState {
  readonly snapshot: CaptionSnapshot;
  readonly selectedId: string | undefined;
  readonly original: boolean;
  readonly diagnostics: boolean;
  readonly expired: boolean;
}

export interface TerminalHandle {
  update(snapshot: CaptionSnapshot): void;
  close(): Promise<void>;
}

function shorten(text: string): string {
  text = stripFormatting(text);
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

function rowText(row: Caption, original: boolean, selected: boolean): string {
  const marker = selected ? "›" : " ";
  const source = shorten(row.text);
  const translation = row.translation;
  if (translation.state === "committed" || translation.state === "provisional") {
    const text = shorten(translation.text);
    const coverage = translation.uncertain ? " · coverage uncertain" : "";
    const provisional = translation.state === "provisional" ? " · provisional" : "";
    return original
      ? `${marker} original: ${source}`
      : `${marker} ${text}${coverage}${provisional}`;
  }
  if (!row.final) return `${marker} ${source} …`;
  const label =
    translation.state === "failed"
      ? `translation failed: ${shorten(translation.reason)}`
      : `translation ${translation.state}`;
  return `${marker} ${source} · ${label}`;
}

function statusText(snapshot: CaptionSnapshot): string {
  const detail =
    snapshot.status === "failed" && snapshot.detail !== undefined
      ? ` — ${shorten(snapshot.detail)}`
      : "";
  return `${snapshot.status}${detail}`;
}

export function TerminalSurface({
  state,
  onAction,
}: {
  readonly state: TerminalState;
  readonly onAction: (action: string) => void;
}): JSX.Element {
  const { columns, rows: terminalRows } = useWindowSize();
  useInput(
    (input, key) => {
      const letter = input.toLowerCase();
      if (key.ctrl && letter === "c") {
        onAction("cancel");
      } else if (letter === "q") {
        onAction("stop");
      } else if (key.escape) {
        onAction("live");
      } else if (letter === "o") {
        onAction("original");
      } else if (letter === "d") {
        onAction("diagnostics");
      } else if (letter === "h") {
        onAction("history");
      } else if (key.upArrow) {
        onAction("up");
      } else if (key.downArrow) {
        onAction("down");
      }
    },
    { isActive: process.stdin.isTTY === true },
  );

  const rows = state.snapshot.rows;
  const selectedIndex =
    state.selectedId === undefined ? -1 : rows.findIndex((row) => row.id === state.selectedId);
  const compact = columns < 64 || terminalRows < 12;
  const title = state.selectedId === undefined ? "Live" : "History";
  const reserved = (state.diagnostics ? 6 : 3) + (state.expired ? 1 : 0);
  const limit = Math.max(1, Math.min(20, terminalRows - reserved));
  const anchor = state.selectedId === undefined ? rows.length - 1 : Math.max(0, selectedIndex);
  const start = Math.max(
    0,
    Math.min(Math.max(0, rows.length - limit), anchor - Math.floor(limit / 2)),
  );
  const visible = rows.slice(start, start + limit);

  return (
    <Box flexDirection="column" width={Math.max(1, columns)}>
      <Text bold wrap="truncate-end">
        urbuddy · {title}
      </Text>
      <Text color={state.snapshot.status === "failed" ? "red" : "cyan"} wrap="truncate-end">
        {statusText(state.snapshot)} · {state.snapshot.gaps} gap
        {state.snapshot.gaps === 1 ? "" : "s"}
      </Text>
      {state.expired ? <Text color="yellow">history item expired</Text> : undefined}
      {visible.length === 0 ? <Text dimColor>No transcript yet.</Text> : undefined}
      {visible.map((row) => (
        <Text
          key={row.id}
          wrap="truncate-end"
          {...(row.id === state.selectedId ? { color: "cyan" } : {})}
        >
          {rowText(row, state.original, row.id === state.selectedId)}
        </Text>
      ))}
      {state.diagnostics ? (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-end">
            {state.snapshot.gaps} source gap{state.snapshot.gaps === 1 ? "" : "s"} ·{" "}
            {state.snapshot.dropped} history rows expired
          </Text>
          {state.snapshot.lastGap === undefined ? undefined : (
            <Text dimColor wrap="truncate-end">
              {shorten(state.snapshot.lastGap)}
            </Text>
          )}
          {state.snapshot.detail === undefined ? undefined : (
            <Text dimColor wrap="truncate-end">
              {shorten(state.snapshot.detail)}
            </Text>
          )}
        </Box>
      ) : undefined}
      <Text dimColor wrap="truncate-end">
        {compact
          ? "h history · Esc live · q stop"
          : "↑↓/h history · Esc live · O original · D diagnostics · q stop"}
      </Text>
    </Box>
  );
}

export function openTerminal(
  initial: CaptionSnapshot,
  stop: () => void,
  cancel: () => void,
): TerminalHandle {
  let state: TerminalState = {
    snapshot: initial,
    selectedId: undefined,
    original: false,
    diagnostics: false,
    expired: false,
  };
  let closed = false;

  const onAction = (action: string): void => {
    if (action === "stop") stop();
    if (action === "cancel") cancel();
    if (action === "live") state = { ...state, selectedId: undefined, expired: false };
    if (action === "original") state = { ...state, original: !state.original };
    if (action === "diagnostics") state = { ...state, diagnostics: !state.diagnostics };
    if (action === "history")
      state = {
        ...state,
        selectedId: state.selectedId ?? state.snapshot.rows.at(-1)?.id,
        expired: false,
      };
    if (action === "up" || action === "down") {
      const rows = state.snapshot.rows;
      if (rows.length > 0) {
        const current =
          state.selectedId === undefined
            ? rows.length
            : rows.findIndex((row) => row.id === state.selectedId);
        const next = Math.max(0, Math.min(rows.length - 1, current + (action === "up" ? -1 : 1)));
        state = { ...state, selectedId: rows[next]?.id, expired: false };
      }
    }
    instance.rerender(<TerminalSurface state={state} onAction={onAction} />);
  };

  const instance = render(<TerminalSurface state={state} onAction={onAction} />, {
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    update(snapshot): void {
      const expired =
        state.selectedId !== undefined && !snapshot.rows.some((row) => row.id === state.selectedId);
      state = { ...state, snapshot, expired };
      instance.rerender(<TerminalSurface state={state} onAction={onAction} />);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}
