import { Box, Text, measureElement, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";

import { END_AT, closing, coverage, participants, questions } from "./scenario.js";
import type { Utterance } from "./scenario.js";
import {
  act,
  advance,
  citedIds,
  initial,
  lifecycle,
  lifecycleChanges,
  noteFlagged,
  questionById,
  recapFor,
  suggestionFor,
  timeLabel,
  translationState,
  utteranceById,
  visibleUtterances,
} from "./session.js";
import type { Session } from "./session.js";

export const MIN_COLS = 60;
export const MIN_ROWS = 12;

export interface Size {
  readonly columns: number;
  readonly rows: number;
}

function SpeakerName({ id }: { readonly id: string }): JSX.Element {
  const found = participants.find((item) => item.id === id);
  return <Text color="gray">{found === undefined ? id : `${found.name} · ${found.role}`}</Text>;
}

function Caption({
  item,
  at,
  showOriginal,
}: {
  readonly item: Utterance;
  readonly at: number;
  readonly showOriginal: boolean;
}): JSX.Element {
  const state = translationState(item, at);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray">
        {timeLabel(item.at)} · <SpeakerName id={item.speaker} />
      </Text>
      {state === "translated" && item.translation !== undefined ? (
        <Text>{item.translation}</Text>
      ) : null}
      {state === "translated" && item.translation !== undefined && showOriginal ? (
        <Text color="gray">EN: {item.text}</Text>
      ) : null}
      {state === "pending" ? <Text color="yellow">Terjemahan menyusul…</Text> : null}
      {state === "none" ? (
        <Box flexDirection="column">
          <Text>{item.text}</Text>
          <Text color="gray">Belum ada terjemahan.</Text>
        </Box>
      ) : null}
      {item.assist === true && item.vocab !== undefined ? (
        <Text color="cyan">Kata: {item.vocab}</Text>
      ) : null}
      {item.assist === true && item.intent !== undefined ? (
        <Text color="cyan">Maksud: {item.intent}</Text>
      ) : null}
    </Box>
  );
}

function Scrolled({
  height,
  width,
  scroll,
  children,
}: {
  readonly height: number;
  readonly width: number;
  readonly scroll: number;
  readonly children: JSX.Element;
}): JSX.Element {
  const content = useRef<Parameters<typeof measureElement>[0]>(null);
  const [max, setMax] = useState(0);
  useLayoutEffect(() => {
    if (content.current !== null) {
      setMax(Math.max(0, measureElement(content.current).height - height));
    }
  }, [children, height, width]);
  return (
    <Box height={height} width={width} flexDirection="column" overflow="hidden">
      <Box
        width={width}
        flexShrink={0}
        flexDirection="column"
        ref={content}
        contentOffsetY={Math.min(scroll, max)}
      >
        {children}
      </Box>
    </Box>
  );
}

function LiveBanner({ at }: { readonly at: number }): JSX.Element | null {
  const latest = questions.findLast((item) => item.at <= at);
  if (latest === undefined) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="yellow">
        Pertanyaan: {latest.meaning} ({latest.addressee}) R untuk respons.
      </Text>
    </Box>
  );
}

function LiveView({ state }: { readonly state: Session }): JSX.Element {
  const recent = visibleUtterances(state.at).slice(-3);
  const notices = coverage.filter((item) => item.at <= state.at);
  return (
    <Box flexDirection="column">
      <Text bold>
        Ikuti · {timeLabel(state.at)} · {state.running ? "live" : "jeda"}
      </Text>
      {!state.guidanceDismissed ? (
        <Text color="gray">
          Ikuti arti Indonesia. R membuka bantuan respons. C memulihkan konteks yang terlewat. ?
          bantuan.
        </Text>
      ) : null}
      <LiveBanner at={state.at} />
      {recent.length === 0 ? <Text color="gray">Rapat dimulai pukul 02:00.</Text> : null}
      {recent.map((item) => (
        <Caption key={item.id} item={item} at={state.at} showOriginal={state.original} />
      ))}
      {notices.map((item) => (
        <Text key={item.at} color="yellow">
          {item.text}
        </Text>
      ))}
      {state.understoodAt !== undefined ? (
        <Text color="gray">Dipahami s/d {timeLabel(state.understoodAt)}.</Text>
      ) : null}
    </Box>
  );
}

function ContextView({ state }: { readonly state: Session }): JSX.Element {
  const recap = recapFor(state.at);
  const ids = citedIds(state);
  const position = ids.findIndex((id) => id === state.contextSel);
  const selected = state.contextSel === undefined ? undefined : utteranceById(state.contextSel);
  const gaps = coverage.filter((item) => item.at <= state.at);
  return (
    <Box flexDirection="column">
      <Text bold>Konteks yang terlewat</Text>
      <Text color="gray">
        Dilihat: {state.lastViewedId ?? "awal"} · Dipahami s/d{" "}
        {state.understoodAt === undefined ? "belum ditandai" : timeLabel(state.understoodAt)}
      </Text>
      {recap === undefined ? (
        <Text color="gray">Belum ada rekap pada titik ini.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Rekap {timeLabel(recap.from)}–{timeLabel(recap.through)}: {recap.text}
          </Text>
          <Text color="yellow">Hanya mencakup rentang itu, bukan seluruh rapat.</Text>
        </Box>
      )}
      {gaps.length === 0 ? (
        <Text color="gray">Tidak ada celah tercatat.</Text>
      ) : (
        gaps.map((item) => (
          <Text key={item.at} color="yellow">
            Celah: {item.text}
          </Text>
        ))
      )}
      {selected === undefined ? (
        <Text color="gray">Tidak ada bukti dikutip.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Bukti {position + 1}/{ids.length} · {selected.id}
          </Text>
          <Caption item={selected} at={state.at} showOriginal={state.original} />
        </Box>
      )}
      <Text color="gray">
        ← → dalam bukti yang dikutip · m tandai dipahami · o asli · Esc live.
      </Text>
    </Box>
  );
}

function RespondDrawer({ state }: { readonly state: Session }): JSX.Element {
  const selected = state.question === undefined ? undefined : questionById(state.question);
  const latestId = questions.findLast((item) => item.at <= state.at)?.id;
  const suggestion = selected === undefined ? undefined : suggestionFor(selected.id);
  const cycle = selected === undefined ? "insufficient" : lifecycle(selected.id, state.at);
  const invalidated = cycle === "invalidated";
  const flagged = noteFlagged(state);
  const changesFor = selected === undefined ? [] : lifecycleChanges(selected.id, state.at);
  return (
    <Box flexDirection="column">
      <Text bold>
        Respons · LIVE {timeLabel(state.at)} {state.running ? "berjalan" : "jeda"}
      </Text>
      {latestId !== undefined && latestId !== selected?.id ? (
        <Text color="yellow">
          Pertanyaan baru masuk — tetap di draf ini. n untuk beralih bila perlu.
        </Text>
      ) : null}
      {selected === undefined ? (
        <Text color="gray">Belum ada pertanyaan pada titik ini.</Text>
      ) : (
        <Box flexDirection="column">
          <Text>{selected.text}</Text>
          <Text color="gray">
            {selected.meaning} ({selected.addressee})
          </Text>
        </Box>
      )}
      {cycle === "ready" && suggestion !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">Saran siap ditinjau — ucapkan dengan kata-katamu bila sesuai.</Text>
          <Text>{suggestion.draftEn}</Text>
          <Text color="gray">{suggestion.draftId}</Text>
        </Box>
      ) : null}
      {cycle === "changed" && suggestion !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">
            Konteks berubah: {changesFor.join(" ")} Saran masih berlaku — periksa sebelum berbicara.
          </Text>
          <Text>{suggestion.draftEn}</Text>
          <Text color="gray">{suggestion.draftId}</Text>
        </Box>
      ) : null}
      {cycle === "pending" && suggestion !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Saran berbasis bukti disiapkan…</Text>
          <Text>Sementara aman dikatakan: {suggestion.holdingEn}</Text>
          <Text color="gray">{suggestion.holdingId}</Text>
        </Box>
      ) : null}
      {cycle === "insufficient" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">Belum ada saran berbasis bukti untuk pertanyaan ini.</Text>
          <Text>
            Aman dikatakan: Boleh saya konfirmasi dulu maksud dan datanya sebelum menjawab?
          </Text>
          <Text color="gray">
            Boleh saya konfirmasi dulu maksud dan datanya sebelum menjawab? (klarifikasi netral —
            bukan jawaban atas isinya)
          </Text>
        </Box>
      ) : null}
      {invalidated ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" bold>
            SARAN KEDALUWARSA — tidak untuk diucapkan. Lihat riwayat bila perlu (u).
          </Text>
          {state.revealedHistory && suggestion !== undefined ? (
            <Box flexDirection="column">
              <Text color="gray">Riwayat (kedaluwarsa): {suggestion.draftEn}</Text>
              <Text color="gray">Riwayat (kedaluwarsa): {suggestion.draftId}</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {state.editing ? (
        <Text color="cyan">Catatan: {state.text}_ (Enter selesai, Esc batal)</Text>
      ) : state.text.length > 0 ? (
        <Text color="cyan">
          Catatan: {state.text}
          {flagged ? " — DITULIS SEBELUM PERUBAHAN, tinjau kembali" : " (x ubah)"}
        </Text>
      ) : (
        <Text color="gray">x untuk menulis catatan bahasa Inggrismu.</Text>
      )}
      {selected !== undefined ? (
        <Text color="gray">
          Bukti: {selected.evidence.join(", ")} · o asli · Esc kembali live (1 langkah).
        </Text>
      ) : null}
    </Box>
  );
}

function ClosedView({ state }: { readonly state: Session }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>Rapat selesai · {timeLabel(state.at)}</Text>
      <Text>{closing.review}</Text>
      <Text color="gray">Kosakata: {closing.learn}</Text>
      {state.showAnswer ? <Text color="green">Jawaban: {closing.answer}</Text> : null}
      {!state.showAnswer ? <Text color="gray">a untuk membuka jawaban.</Text> : null}
    </Box>
  );
}

function HelpOverlay({ state }: { readonly state: Session }): JSX.Element {
  const lines =
    state.view === "context"
      ? ["← → bukti yang dikutip", "m tandai dipahami", "o asli", "Esc live"]
      : state.view === "respond"
        ? [
            "x catat · Enter selesai",
            "n pertanyaan terbaru",
            "u riwayat saran",
            "o asli",
            "Esc live",
          ]
        : state.view === "closed"
          ? ["a jawaban", "Esc live"]
          : state.replay
            ? ["Space putar/jeda · . langkah", "C pulihkan · R respons", "Esc live"]
            : ["C pulihkan · R respons", "Esc live · q keluar"];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Bantuan</Text>
      {lines.map((line) => (
        <Text key={line} color="gray">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function FooterHints({ state }: { readonly state: Session }): JSX.Element {
  if (state.view === "context") return <Text color="gray">C konteks · Esc live · q keluar</Text>;
  if (state.view === "respond")
    return <Text color="gray">R respons · x catat · n terbaru · Esc live · q keluar</Text>;
  if (state.view === "closed") return <Text color="gray">a jawaban · Esc live · q keluar</Text>;
  if (state.replay)
    return (
      <Text color="gray">Space putar/jeda · . langkah · C pulihkan · R respons · q keluar</Text>
    );
  return <Text color="gray">C pulihkan · R respons · ? bantuan · q keluar</Text>;
}

function DegradedView({
  size,
  state,
}: {
  readonly size: Size;
  readonly state: Session;
}): JSX.Element {
  const selected = state.question === undefined ? undefined : questionById(state.question);
  const cycle = selected === undefined ? undefined : lifecycle(selected.id, state.at);
  const label =
    cycle === "ready"
      ? "siap"
      : cycle === "pending"
        ? "disiapkan"
        : cycle === "changed"
          ? "berubah (masih berlaku)"
          : cycle === "invalidated"
            ? "kedaluwarsa"
            : "belum ada";
  return (
    <Box flexDirection="column">
      <Text color="red" bold>
        Layar terlalu kecil ({size.columns}×{size.rows}). Perbesar ke ≥{MIN_COLS}×{MIN_ROWS}.
      </Text>
      <Text>Tampilan diringkas — status tersimpan, tidak ada yang hilang.</Text>
      <Text>
        {timeLabel(state.at)} · {state.view}
        {selected === undefined ? "" : ` · ${selected.meaning}`}
      </Text>
      <Text color={cycle === "invalidated" ? "red" : "yellow"}>
        Status saran: {label}
        {noteFlagged(state) ? " · catatan perlu ditinjau" : ""}
      </Text>
      <Text color="gray">Kontrol tetap aktif: C pulihkan · R respons · Esc live · q keluar.</Text>
    </Box>
  );
}

export function AdaptiveApp({
  start,
  speed,
  replay,
}: {
  readonly start: number;
  readonly speed: number;
  readonly replay: boolean;
}): JSX.Element {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [state, setState] = useState<Session>(() => ({
    ...initial(Math.min(start, END_AT), replay),
    running: true,
  }));
  const size: Size = { columns, rows };
  useEffect(() => {
    if (!state.running) return;
    const timer = setInterval(() => {
      setState((previous) => {
        if (!previous.running) return previous;
        const next = Math.min(previous.at + speed / 4, END_AT);
        return advance(previous, next, next < END_AT);
      });
    }, 250);
    return () => {
      clearInterval(timer);
    };
  }, [state.running, speed]);
  useInput((input, key) => {
    if (key.escape) {
      setState((previous) => act(previous, "esc"));
      return;
    }
    if (key.return) {
      setState((previous) => act(previous, "enter"));
      return;
    }
    if (key.backspace || key.delete) {
      setState((previous) => act(previous, "backspace"));
      return;
    }
    if (key.upArrow) {
      setState((previous) => act(previous, "up"));
      return;
    }
    if (key.downArrow) {
      setState((previous) => act(previous, "down"));
      return;
    }
    if (key.leftArrow) {
      setState((previous) => act(previous, "left"));
      return;
    }
    if (key.rightArrow) {
      setState((previous) => act(previous, "right"));
      return;
    }
    if (input === "q" && !state.editing) {
      exit();
      return;
    }
    if (input.length === 0) return;
    if (state.editing) {
      setState((previous) => act(previous, `input:${input}`));
      return;
    }
    setState((previous) => act(previous, input));
  });
  return <AdaptiveScreen state={state} size={size} />;
}

export function AdaptiveScreen({
  state,
  size,
}: {
  readonly state: Session;
  readonly size: Size;
}): JSX.Element {
  const degraded = size.columns < MIN_COLS || size.rows < MIN_ROWS;
  const bodyHeight = Math.max(3, size.rows - 4);
  return (
    <Box flexDirection="column">
      <Text bold>Urbuddy · alur tunggal · bukan sesi P01</Text>
      {degraded ? (
        <DegradedView size={size} state={state} />
      ) : (
        <Scrolled height={bodyHeight} width={size.columns} scroll={state.scroll}>
          <Box flexDirection="column">
            {state.view === "live" ? <LiveView state={state} /> : null}
            {state.view === "context" ? <ContextView state={state} /> : null}
            {state.view === "respond" ? <RespondDrawer state={state} /> : null}
            {state.view === "closed" ? <ClosedView state={state} /> : null}
            {state.help ? <HelpOverlay state={state} /> : null}
          </Box>
        </Scrolled>
      )}
      {degraded ? <Text color="gray">Esc live · q keluar.</Text> : <FooterHints state={state} />}
    </Box>
  );
}
