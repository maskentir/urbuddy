import { Box, measureElement, Text, useApp, useInput, useWindowSize } from "ink";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { type SourceRow, timeLabel } from "../model.js";
import { participants } from "../scenario.js";

import { closing, recaps } from "./scenario.js";
import {
  act,
  advance,
  DEFAULT_ROLES,
  citedIds,
  HISTORY_LIMIT,
  initial,
  type Language,
  newContext,
  responseFor,
  type Roles,
  sceneAt,
  type Session,
  translationStatus,
} from "./session.js";

const paper = "#F4F0DF";
const muted = "#ADA891";
const acid = "#BAF52E";
const warning = "#FF633B";

type Scene = ReturnType<typeof sceneAt>;
type Dimensions = { readonly columns: number; readonly rows: number };

function Line({
  children,
  color = paper,
  bold = false,
}: {
  readonly children: ReactNode;
  readonly color?: string;
  readonly bold?: boolean;
}) {
  return (
    <Text color={color} bold={bold} wrap="wrap">
      {children}
    </Text>
  );
}

function Viewport({
  children,
  height,
  width,
  scroll,
  report,
}: {
  readonly children: ReactNode;
  readonly height: number;
  readonly width: number;
  readonly scroll: number;
  readonly report: (max: number) => void;
}) {
  const content = useRef<Parameters<typeof measureElement>[0]>(null);
  const [max, setMax] = useState(0);
  useLayoutEffect(() => {
    if (content.current) {
      const result = Math.max(0, measureElement(content.current).height - height);
      setMax(result);
      report(result);
    }
  }, [children, height, width, report]);
  return (
    <Box
      height={height}
      width={width}
      flexDirection="column"
      overflow="hidden"
      contentOffsetY={Math.min(scroll, max)}
    >
      <Box width={width} flexShrink={0} flexDirection="column" ref={content}>
        {children}
      </Box>
    </Box>
  );
}

function Caption({
  row,
  comprehension,
  original,
  details = false,
}: {
  readonly row: SourceRow;
  readonly comprehension: Language;
  readonly original: boolean;
  readonly details?: boolean;
}) {
  const { speech, translation } = row;
  const status = translationStatus(row);
  const speaker = participants.find(({ id }) => id === speech.speaker)?.name ?? speech.speaker;
  const translated =
    status === "translated" && translation?.kind === "translation" ? translation : undefined;
  const targetIsSource = speech.language === comprehension;
  const showTarget = comprehension === "id" && translated && !targetIsSource;
  const labels = {
    translated: "Diterjemahkan",
    pending: "Menunggu terjemahan",
    unavailable: "Terjemahan tidak tersedia",
    unknown: "Cakupan terjemahan tidak diketahui",
  };
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Line color={row.supersededBy ? warning : muted}>
        {timeLabel(speech.at)} · {speaker}
        {speech.speakerUncertain ? "?" : ""}
        {!speech.final ? " · parsial" : ""}
        {speech.overlap ? " · tumpang tindih" : ""}
        {row.supersededBy ? " · digantikan" : ""}
      </Line>
      {showTarget ? (
        <>
          <Line>{translated.text}</Line>
          <Line color={muted}>
            ID · {labels.translated} {timeLabel(translated.at)}
          </Line>
          {original && <Line color={muted}>Asli · {speech.text}</Line>}
        </>
      ) : (
        <>
          <Line>{speech.text}</Line>
          <Line color={status === "unavailable" || row.supersededBy ? warning : muted}>
            {row.supersededBy
              ? "Sumber historis"
              : targetIsSource
                ? "Ucapan asli"
                : comprehension === "en"
                  ? "Asli · terjemahan EN tidak disediakan di fixture"
                  : `Asli · ${labels[status]}`}
          </Line>
        </>
      )}
      {details && row.supersededBy && (
        <Line color={warning}>Digantikan oleh {row.supersededBy}</Line>
      )}
    </Box>
  );
}

function Contents({
  state,
  scene,
  roles,
}: {
  readonly state: Session;
  readonly scene: Scene;
  readonly roles: Roles;
}) {
  const { view, at, selected, understood, lastViewed, question } = state;
  const answer = responseFor(state);
  const changes = newContext(state);
  const latest = changes.at(-1);
  const recap = recaps.findLast((entry) => entry.at <= at);
  const selectedRow = scene.retained.find(({ speech }) => speech.id === selected);
  if (view === "follow") {
    return scene.recent.length === 0 ? (
      <Line color={muted}>Belum ada ucapan yang tertangkap.</Line>
    ) : (
      scene.recent.map((row) => (
        <Caption
          key={row.speech.id}
          row={row}
          comprehension={roles.comprehension}
          original={state.original}
        />
      ))
    );
  }
  if (view === "respond") {
    if (state.selectionError !== undefined) {
      return (
        <Line color={warning}>
          {state.selectionError
            ? `Ucapan ${state.selectionError} tidak memiliki pertanyaan yang disimulasikan.`
            : "Belum ada pertanyaan."}
        </Line>
      );
    }
    if (!answer) return <Line>Belum ada pertanyaan.</Line>;
    const originalQuestion = scene.retained.find(({ speech }) => speech.id === answer.id)?.speech
      .text;
    const missing = answer.evidence.filter(
      (id) => !scene.retained.some(({ speech }) => speech.id === id),
    ).length;
    return (
      <>
        <Line color={acid} bold>
          {timeLabel(answer.at)} · Pertanyaan dipilih
        </Line>
        <Line>{answer.question[roles.comprehension]}</Line>
        <Line color={muted}>{answer.addressed[roles.comprehension]}</Line>
        {state.editing && (
          <Text color={acid} wrap="truncate-start">
            Catatan Anda › {state.text || "…"}▏
          </Text>
        )}
        {state.original && (
          <Line color={muted}>Asli · {originalQuestion ?? "Ucapan tidak tersedia"}</Line>
        )}
        {latest && (
          <>
            <Line color={warning} bold>
              {timeLabel(latest.at)} · Konteks baru (simulasi)
            </Line>
            <Line color={warning}>{latest.text[roles.comprehension]}</Line>
          </>
        )}
        {missing > 0 && <Line color={warning}>{missing} bukti draft di luar riwayat.</Line>}
        {!state.editing && state.text && <Line color={acid}>Catatan Anda › {state.text}</Line>}
        {state.revealed && answer.response && (
          <>
            <Line color={changes.length ? warning : acid} bold>
              {changes.length ? "Draft lama · tinjau sebelum digunakan" : "Usulan simulasi"}
            </Line>
            <Line>
              {roles.reply.toUpperCase()} · {answer.response[roles.reply]}
            </Line>
            {roles.reply !== roles.comprehension && (
              <Line color={muted}>
                {roles.comprehension.toUpperCase()} · {answer.response[roles.comprehension]}
              </Line>
            )}
          </>
        )}
        {!answer.response && <Line color={warning}>Tidak ada draft untuk pembicara lain.</Line>}
      </>
    );
  }
  if (view === "catchup") {
    const retained = understood && scene.retained.some(({ speech }) => speech.id === understood.id);
    const missing = recap?.evidence.filter(
      (id) => !scene.retained.some(({ speech }) => speech.id === id),
    ).length;
    return (
      <>
        <Line>Terakhir dipahami · {understood ? timeLabel(understood.at) : "belum ditandai"}</Line>
        {understood && !retained && (
          <Line color={warning}>Titik pemulihan di luar riwayat. Ucapan asal tidak tersedia.</Line>
        )}
        <Line>Terakhir dilihat · {lastViewed ? timeLabel(lastViewed.at) : "belum ada"}</Line>
        <Line color={acid} bold>
          Cakupan recap simulasi
        </Line>
        {recap ? (
          <>
            <Line color={muted}>
              {timeLabel(recap.from)}–{timeLabel(recap.through)} · bukti terpilih
            </Line>
            <Line>{recap.text[roles.comprehension]}</Line>
            {missing ? (
              <Line color={warning}>{missing} rujukan tidak tersedia di riwayat.</Line>
            ) : null}
            <Line color={muted}>Ucapan di luar cakupan belum diringkas.</Line>
          </>
        ) : (
          <Line color={muted}>Belum tersedia.</Line>
        )}
      </>
    );
  }
  if (view === "history" || view === "translations" || view === "evidence") {
    const count =
      view === "evidence"
        ? citedIds(state).length
        : view === "history"
          ? scene.retained.length
          : scene.olderTranslations.length;
    return (
      <>
        <Line color={muted}>
          {view === "history"
            ? `Riwayat ${count}/${HISTORY_LIMIT} · replay terus maju`
            : view === "evidence"
              ? state.recapEvidence
                ? `${count} rujukan recap`
                : `${count} rujukan untuk ${question ?? "pertanyaan"}`
              : `${count} terjemahan untuk ucapan di luar feed`}
        </Line>
        {view === "evidence" && selected && (
          <Line color={muted}>
            {state.recapEvidence
              ? "Rujukan recap"
              : answer?.evidence.some((id) => id === selected)
                ? "Rujukan draft"
                : "Konteks baru · tinjau terpisah"}
          </Line>
        )}
        {selectedRow ? (
          <Caption
            row={selectedRow}
            comprehension={roles.comprehension}
            original={state.original || view === "evidence"}
            details
          />
        ) : (
          <Line color={warning}>
            {selected
              ? `Bukti ${selected} tidak tersedia di riwayat.`
              : "Belum ada ucapan untuk tampilan ini."}
          </Line>
        )}
      </>
    );
  }
  if (view === "review" || view === "learn") {
    return !scene.closed ? (
      <Line>Tersedia setelah rapat selesai.</Line>
    ) : (
      <>
        <Line color={acid} bold>
          {view === "review" ? "Handoff simulasi" : "Latihan simulasi"}
        </Line>
        <Line>{closing[view][roles.comprehension]}</Line>
        {view === "learn" && state.showAnswer && (
          <Line color={acid}>{closing.answer[roles.comprehension]}</Line>
        )}
      </>
    );
  }
  return (
    <>
      <Line>Space putar/jeda · . event · ] bab</Line>
      <Line>c pulihkan · h riwayat · t terjemahan · r jawab</Line>
      <Line>m tandai dipahami · o asli · i detail · w panel lebar</Line>
      <Line>Jawab: d draft · x catatan · e bukti · n pilih terbaru</Line>
      <Line>← → pilih bukti · ↑ ↓ gulir · Esc live · q keluar</Line>
      <Line>v review · l latihan · a jawaban</Line>
    </>
  );
}

function hint(state: Session, hasReply: boolean): string {
  switch (state.view) {
    case "follow":
      return "c Pulihkan · h Riwayat · r Jawab · ?";
    case "respond":
      if (state.selectionError !== undefined) return "n Pertanyaan terbaru";
      return state.editing
        ? "Enter Selesai"
        : hasReply
          ? "d Draft · x Catat · e Bukti · n Baru"
          : "e Bukti · n Baru";
    case "evidence":
      return state.recapEvidence ? "←→ Bukti · c Recap" : "←→ Bukti · r Draft";
    case "history":
      return "←→ Ucapan · r Jawab · m Tandai";
    case "translations":
      return "←→ Pilih · o Asli";
    case "learn":
      return "a Jawaban";
    case "catchup":
      return "e Bukti · ? Tombol";
    case "review":
    case "keys":
      return "? Tombol";
  }
}

const names = {
  follow: "IKUTI",
  catchup: "PULIHKAN",
  respond: "JAWAB",
  evidence: "BUKTI",
  history: "RIWAYAT",
  translations: "TERJEMAHAN",
  review: "TINJAU",
  learn: "LATIHAN",
  keys: "TOMBOL",
};

export function ConversationScreen({
  state,
  size,
  roles = DEFAULT_ROLES,
  onScrollable,
}: {
  readonly state: Session;
  readonly size: Dimensions;
  readonly roles?: Roles;
  readonly onScrollable?: (max: number) => void;
}) {
  const { columns, rows } = size;
  const scene = sceneAt(state.at);
  const [max, setMax] = useState(0);
  const changes = newContext(state);
  const failedDraft = changes.some(({ id }) => id === "migration-failed");
  const updateScroll = useCallback(
    (limit: number) => {
      setMax(limit);
      onScrollable?.(limit);
    },
    [onScrollable],
  );
  const lastCoverage = scene.coverage.at(-1);
  const status = [
    lastCoverage?.kind === "gap" ? "Gap aktif" : lastCoverage ? "Celah tetap ada" : "",
    scene.failed ? "ID gagal" : "",
    scene.pending ? `Antrean ${scene.pending}` : "",
    scene.olderTranslations.length ? `t Terjemahan ${scene.olderTranslations.length}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const attention =
    changes.length > 0
      ? failedDraft
        ? "Draft usang · migrasi gagal"
        : "Draft usang · konteks baru"
      : state.at >= 660 && state.at < 1442
        ? "Migrasi gagal · tahan deploy"
        : "";
  const wide = state.wide && columns >= 88 && state.view !== "follow";
  const showStatus = state.showStatus && rows >= 10;
  const details = showStatus ? 2 : 0;
  const bodyHeight = Math.max(1, rows - 4 - details - Number(Boolean(attention)));
  const mainWidth = wide ? Math.floor(columns * 0.64) : columns;
  const clock = state.running ? "▶" : "Ⅱ";
  const answer = responseFor(state);
  const inlineHint = hint(state, Boolean(answer?.response));
  return (
    <Box width={columns} flexDirection="column">
      <Text color={acid} bold wrap="truncate-end">
        URBUDDY · {names[state.view]} · {timeLabel(state.at)} {clock}
      </Text>
      <Text color={muted} wrap="truncate-end">
        Simulasi offline · 0 kirim/simpan
      </Text>
      <Text
        color={lastCoverage || scene.failed || scene.pending ? warning : muted}
        wrap="truncate-end"
      >
        {status || "Layanan replay normal"}
      </Text>
      {attention && (
        <Text color={warning} bold wrap="truncate-end">
          {attention}
        </Text>
      )}
      {showStatus && (
        <>
          <Text color={muted} wrap="truncate-end">
            Input: fixture · mikrofon mati
          </Text>
          <Text color={muted} wrap="truncate-end">
            Kirim/simpan: nihil · catatan di RAM
          </Text>
        </>
      )}
      <Box flexDirection="row" gap={wide ? 1 : 0}>
        <Viewport width={mainWidth} height={bodyHeight} scroll={state.scroll} report={updateScroll}>
          <Contents state={state} scene={scene} roles={roles} />
        </Viewport>
        {wide && (
          <Box
            width={columns - mainWidth - 1}
            height={bodyHeight}
            overflow="hidden"
            flexDirection="column"
          >
            <Line color={acid} bold>
              Terkini
            </Line>
            {scene.recent.slice(0, 2).map((row) => (
              <Caption
                key={row.speech.id}
                row={row}
                comprehension={roles.comprehension}
                original={false}
              />
            ))}
          </Box>
        )}
      </Box>
      <Text color={muted} wrap="truncate-end">
        {state.view !== "follow" ? "Esc Live · " : ""}
        {max > 0 && !state.editing ? `↑↓ ${Math.min(state.scroll, max) + 1}/${max + 1} · ` : ""}
        {inlineHint}
      </Text>
    </Box>
  );
}

export function Conversation({
  start,
  wide,
  play,
  speed,
  roles,
  size,
}: {
  readonly start: number;
  readonly wide: boolean;
  readonly play: boolean;
  readonly speed: number;
  readonly roles: Roles;
  readonly size?: Dimensions;
}) {
  const window = useWindowSize();
  const { exit } = useApp();
  const [state, set] = useState(() => initial(start, wide, play));
  const scrollLimit = useRef(0);
  const onScrollable = useCallback((limit: number) => {
    scrollLimit.current = limit;
  }, []);
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
      if (seconds <= 0) return;
      remainder -= seconds;
      set((current) => (current.running ? advance(current, current.at + seconds) : current));
    }, 100);
    return () => clearInterval(timer);
  }, [running, speed]);
  useInput((input, key) => {
    if (key.eventType === "release") return;
    if (input === "q" && !state.editing) {
      exit();
      return;
    }
    const command = key.escape
      ? "esc"
      : key.return
        ? "enter"
        : key.backspace || key.delete
          ? "backspace"
          : key.upArrow
            ? "up"
            : key.downArrow
              ? "down"
              : key.leftArrow
                ? "left"
                : key.rightArrow
                  ? "right"
                  : state.editing && !key.ctrl && !key.meta
                    ? `input:${input}`
                    : input;
    set((current) => {
      if (command !== "up" && command !== "down") return act(current, command);
      const next = act(
        { ...current, scroll: Math.min(current.scroll, scrollLimit.current) },
        command,
      );
      return { ...next, scroll: Math.min(next.scroll, scrollLimit.current) };
    });
  });
  return (
    <ConversationScreen
      state={state}
      size={size ?? window}
      roles={roles}
      onScrollable={onScrollable}
    />
  );
}
