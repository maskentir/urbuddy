import { Box, Text, measureElement, useApp, useInput, useWindowSize } from "ink";
import { useLayoutEffect, useRef, useState, type JSX } from "react";

import {
  evidenceLabels,
  questionStatus,
  type ProjectedQuestion,
  type ProjectedUtterance,
} from "./projection.js";
import { citedIds, latestQuestionId, timeLabel } from "./session.js";
import type { Session, UserState } from "./session.js";

export const MIN_COLS = 60;
export const MIN_ROWS = 12;

export interface Size {
  readonly columns: number;
  readonly rows: number;
}

function SpeakerName({
  state,
  speakerKey,
}: {
  readonly state: Session;
  readonly speakerKey: string;
}): JSX.Element {
  const found = state.domain.roster.find((item) => item.speakerKey === speakerKey);
  return (
    <Text color="gray">{found === undefined ? speakerKey : `${found.name} · ${found.role}`}</Text>
  );
}

function Caption({
  state,
  item,
}: {
  readonly state: Session;
  readonly item: ProjectedUtterance;
}): JSX.Element {
  const showOriginal = state.user.original;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="gray">
        {timeLabel(item.firstSeenAtMs / 1000)} ·{" "}
        <SpeakerName state={state} speakerKey={item.speakerKey} />
      </Text>
      {item.translation !== undefined ? <Text>{item.translation.text}</Text> : null}
      {item.translation === undefined && item.expectsTranslation && item.finalized ? (
        <Text color="yellow">Terjemahan menyusul…</Text>
      ) : null}
      {item.translation === undefined && !item.expectsTranslation ? (
        <Box flexDirection="column">
          <Text>{item.text}</Text>
          {item.finalized ? (
            <Text color="gray">
              {state.assistanceEnabled === false
                ? "Terjemahan tidak diaktifkan."
                : "Belum ada terjemahan."}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {item.translation !== undefined && showOriginal ? (
        <Text color="gray">EN: {item.text}</Text>
      ) : null}
      {item.assists && item.vocab !== undefined ? (
        <Text color="cyan">Kata: {item.vocab}</Text>
      ) : null}
      {item.assists && item.intent !== undefined ? (
        <Text color="cyan">Maksud: {item.intent}</Text>
      ) : null}
      {!item.finalized ? <Text color="yellow">Parsial — belum final.</Text> : null}
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

function LiveBanner({ state }: { readonly state: Session }): JSX.Element | null {
  const latestId = state.domain.questionOrder[state.domain.questionOrder.length - 1];
  const latest = latestId === undefined ? undefined : state.domain.questions.get(latestId);
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
  const recent = state.domain.utterances.slice(-3);
  return (
    <Box flexDirection="column">
      <Text bold>
        Ikuti · {timeLabel(state.atMs / 1000)} · {state.running ? "live" : "jeda"}
      </Text>
      {!state.user.guidanceDismissed ? (
        <Text color="gray">
          Ikuti arti Indonesia. R membuka bantuan respons. C memulihkan konteks yang terlewat. ?
          bantuan.
        </Text>
      ) : null}
      <LiveBanner state={state} />
      {recent.length === 0 ? <Text color="gray">Rapat dimulai — menunggu audio.</Text> : null}
      {recent.map((item) => (
        <Caption key={item.key} state={state} item={item} />
      ))}
      {state.domain.gapDetails.map((detail) => (
        <Text key={detail} color="yellow">
          {detail}
        </Text>
      ))}
      {state.domain.gaps.map((gap) => (
        <Text key={`${gap.fromSeq}-${gap.toSeq}`} color="yellow">
          Celah liputan: sekuens {gap.fromSeq}–{gap.toSeq} tidak memiliki transkrip.
        </Text>
      ))}
      {state.user.understoodKey !== undefined ? (
        <Text color="gray">Dipahami s/d {timeLabel((state.user.understoodAtMs ?? 0) / 1000)}.</Text>
      ) : null}
    </Box>
  );
}

function ContextView({ state }: { readonly state: Session }): JSX.Element {
  const recap = state.domain.recap;
  const ids = citedIds(state);
  const position = ids.findIndex((id) => id === state.user.contextSel);
  const selectedKey = state.user.contextSel === undefined ? undefined : state.user.contextSel;
  const selected = selectedKey === undefined ? undefined : state.domain.byKey.get(selectedKey);
  const cited = selectedKey !== undefined && ids.includes(selectedKey);
  const gaps = state.domain.gapDetails;
  return (
    <Box flexDirection="column">
      <Text bold>Konteks yang terlewat</Text>
      <Text color="gray">
        Dilihat:{" "}
        {state.user.lastViewedKey === undefined
          ? "awal"
          : (state.domain.byKey.get(state.user.lastViewedKey)?.turnRef ??
            state.user.lastViewedKey)}{" "}
        · Dipahami s/d{" "}
        {state.user.understoodKey === undefined
          ? "belum ditandai"
          : (state.domain.byKey.get(state.user.understoodKey)?.turnRef ?? state.user.understoodKey)}
      </Text>
      {recap === undefined ? (
        <Text color="gray">Belum ada rekap pada titik ini.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Rekap {timeLabel(recap.fromMs / 1000)}–{timeLabel(recap.throughMs / 1000)}: {recap.text}
          </Text>
          <Text color="yellow">Hanya mencakup rentang itu, bukan seluruh rapat.</Text>
        </Box>
      )}
      {gaps.length === 0 ? (
        <Text color="gray">Tidak ada celah tercatat.</Text>
      ) : (
        gaps.map((detail) => (
          <Text key={detail} color="yellow">
            Celah: {detail}
          </Text>
        ))
      )}
      {selected === undefined ? (
        <Text color="gray">Tidak ada bukti dikutip.</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {cited ? (
            <Text>
              Bukti {position + 1}/{ids.length} · {selected.turnRef}
            </Text>
          ) : (
            <Text color="yellow">
              Sumber ini tidak lagi dikutip rekap terbaru — isi dipertahankan.
            </Text>
          )}
          <Caption state={state} item={selected} />
        </Box>
      )}
      <Text color="gray">
        ← → dalam bukti yang dikutip · m tandai dipahami · o asli · Esc live.
      </Text>
    </Box>
  );
}

function DrawerSuggestion({
  state,
  question,
}: {
  readonly state: Session;
  readonly question: ProjectedQuestion;
}): JSX.Element | null {
  const status = questionStatus(question);
  if (status === "ready" || status === "changed") {
    const suggestion = question.suggestion;
    if (suggestion === undefined) return null;
    return (
      <Box flexDirection="column" marginTop={1}>
        {status === "changed" ? (
          <Text color="yellow">
            Konteks berubah: {question.changes.join(" ")} Saran masih berlaku — periksa sebelum
            berbicara.
          </Text>
        ) : (
          <Text color="green">Saran siap ditinjau — ucapkan dengan kata-katamu bila sesuai.</Text>
        )}
        <Text>{suggestion.draftEn}</Text>
        <Text color="gray">{suggestion.draftId}</Text>
      </Box>
    );
  }
  if (status === "pending") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">Saran berbasis bukti disiapkan…</Text>
        {question.pendingHolding !== undefined ? (
          <Box flexDirection="column">
            <Text>Sementara aman dikatakan: {question.pendingHolding.holdingEn}</Text>
            <Text color="gray">{question.pendingHolding.holdingId}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  if (status === "insufficient") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">Belum ada saran berbasis bukti untuk pertanyaan ini.</Text>
        {question.insufficientHolding !== undefined ? (
          <Box flexDirection="column">
            <Text>Aman dikatakan: {question.insufficientHolding.holdingEn}</Text>
            <Text color="gray">
              {question.insufficientHolding.holdingId} (klarifikasi netral — bukan jawaban atas
              isinya)
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="red" bold>
        SARAN KEDALUWARSA — tidak untuk diucapkan. Lihat riwayat bila perlu (u).
      </Text>
      {state.user.revealedHistory && question.suggestion !== undefined ? (
        <Box flexDirection="column">
          <Text color="gray">Riwayat (kedaluwarsa): {question.suggestion.draftEn}</Text>
          <Text color="gray">Riwayat (kedaluwarsa): {question.suggestion.draftId}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function RespondDrawer({ state }: { readonly state: Session }): JSX.Element {
  const selected =
    state.user.question === undefined ? undefined : state.domain.questions.get(state.user.question);
  const latestId = latestQuestionId(state);
  const flagged =
    selected !== undefined &&
    selected.invalidated &&
    state.user.noteAtMs !== undefined &&
    selected.invalidatedAtMs !== undefined &&
    state.user.noteAtMs < selected.invalidatedAtMs;
  return (
    <Box flexDirection="column">
      <Text bold>
        Respons · LIVE {timeLabel(state.atMs / 1000)} {state.running ? "berjalan" : "jeda"}
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
          <DrawerSuggestion state={state} question={selected} />
        </Box>
      )}
      {state.user.editing ? (
        <Text color="cyan">Catatan: {state.user.text}_ (Enter selesai, Esc batal)</Text>
      ) : state.user.text.length > 0 ? (
        <Text color="cyan">
          Catatan: {state.user.text}
          {flagged ? " — DITULIS SEBELUM PERUBAHAN, tinjau kembali" : " (x ubah)"}
        </Text>
      ) : (
        <Text color="gray">x untuk menulis catatan bahasa Inggrismu.</Text>
      )}
      {selected !== undefined ? (
        <Box flexDirection="column">
          <Text color="gray">
            Bukti: {evidenceLabels(state.domain, selected.resolvedEvidence).join(", ") || "—"} · o
            asli · Esc kembali live (1 langkah).
          </Text>
          {selected.unavailableEvidence.length > 0 ? (
            <Text color="yellow">Belum tercakup: {selected.unavailableEvidence.join(", ")}.</Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

function ClosedView({ state }: { readonly state: Session }): JSX.Element {
  const closed = state.domain.closed;
  if (closed === undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>Rapat selesai · {timeLabel(state.atMs / 1000)}</Text>
        <Text color="gray">Ringkasan belum tersedia.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>Rapat selesai · {timeLabel(state.atMs / 1000)}</Text>
      <Text>{closed.review}</Text>
      <Text color="gray">Kosakata: {closed.learn}</Text>
      {state.user.showAnswer ? <Text color="green">Jawaban: {closed.answer}</Text> : null}
      {!state.user.showAnswer ? <Text color="gray">a untuk membuka jawaban.</Text> : null}
    </Box>
  );
}

function HelpOverlay({ user }: { readonly user: UserState }): JSX.Element {
  const lines =
    user.view === "context"
      ? ["← → bukti yang dikutip", "m tandai dipahami", "o asli", "Esc live"]
      : user.view === "respond"
        ? [
            "x catat · Enter selesai",
            "n pertanyaan terbaru",
            "u riwayat saran",
            "o asli",
            "Esc live",
          ]
        : user.view === "closed"
          ? ["a jawaban", "Esc live"]
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

function FooterHints({ user }: { readonly user: UserState }): JSX.Element {
  if (user.view === "context") return <Text color="gray">C konteks · Esc live · q keluar</Text>;
  if (user.view === "respond")
    return <Text color="gray">R respons · x catat · n terbaru · Esc live · q keluar</Text>;
  if (user.view === "closed") return <Text color="gray">a jawaban · Esc live · q keluar</Text>;
  return (
    <Text color="gray">Space jeda/lanjut · C pulihkan · R respons · ? bantuan · q keluar</Text>
  );
}

function DegradedView({
  size,
  state,
}: {
  readonly size: Size;
  readonly state: Session;
}): JSX.Element {
  const selected =
    state.user.question === undefined ? undefined : state.domain.questions.get(state.user.question);
  const label =
    selected === undefined
      ? "—"
      : selected.suggestion === undefined
        ? selected.insufficient
          ? "belum ada"
          : "disiapkan"
        : selected.invalidated
          ? "kedaluwarsa"
          : selected.changes.length > 0
            ? "berubah (masih berlaku)"
            : "siap";
  return (
    <Box flexDirection="column">
      <Text color="red" bold>
        Layar terlalu kecil ({size.columns}×{size.rows}). Perbesar ke ≥{MIN_COLS}×{MIN_ROWS}.
      </Text>
      <Text>Tampilan diringkas — status tersimpan, tidak ada yang hilang.</Text>
      <Text>
        {timeLabel(state.atMs / 1000)} · {state.user.view}
        {selected === undefined ? "" : ` · ${selected.meaning}`}
      </Text>
      <Text color={selected?.invalidated === true ? "red" : "yellow"}>
        Status saran: {label}
        {selected !== undefined &&
        selected.invalidated &&
        state.user.noteAtMs !== undefined &&
        selected.invalidatedAtMs !== undefined &&
        state.user.noteAtMs < selected.invalidatedAtMs
          ? " · catatan perlu ditinjau"
          : ""}
      </Text>
      <Text color="gray">Kontrol tetap aktif: C pulihkan · R respons · Esc live · q keluar.</Text>
    </Box>
  );
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
        <Scrolled height={bodyHeight} width={size.columns} scroll={state.user.scroll}>
          <Box flexDirection="column">
            {state.user.view === "live" ? <LiveView state={state} /> : null}
            {state.user.view === "context" ? <ContextView state={state} /> : null}
            {state.user.view === "respond" ? <RespondDrawer state={state} /> : null}
            {state.user.view === "closed" ? <ClosedView state={state} /> : null}
            {state.user.help ? <HelpOverlay user={state.user} /> : null}
          </Box>
        </Scrolled>
      )}
      {degraded ? (
        <Text color="gray">Esc live · q keluar.</Text>
      ) : (
        <FooterHints user={state.user} />
      )}
    </Box>
  );
}

export interface AppController {
  actUser: (key: string, clockMs: number) => void;
  pauseToggle: () => void;
  shutdown: (code: number) => void;
  snapshot: () => Session;
  clockMs: () => number;
}

export function AdaptiveApp({ controller }: { readonly controller: AppController }): JSX.Element {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [, bump] = useState(0);
  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "\u0003") {
      controller.shutdown(130);
      exit();
      return;
    }
    if (key.escape) {
      controller.actUser("esc", controller.clockMs());
    } else if (key.return) {
      controller.actUser("enter", controller.clockMs());
    } else if (key.backspace || key.delete) {
      controller.actUser("backspace", controller.clockMs());
    } else if (key.upArrow) {
      controller.actUser("up", controller.clockMs());
    } else if (key.downArrow) {
      controller.actUser("down", controller.clockMs());
    } else if (key.leftArrow) {
      controller.actUser("left", controller.clockMs());
    } else if (key.rightArrow) {
      controller.actUser("right", controller.clockMs());
    } else if (input === " " && !controller.snapshot().user.editing) {
      controller.pauseToggle();
    } else if (input === "q" && !controller.snapshot().user.editing) {
      controller.shutdown(0);
      exit();
      return;
    } else if (input.length > 0) {
      const editing = controller.snapshot().user.editing;
      controller.actUser(editing ? `input:${input}` : input, controller.clockMs());
    } else {
      return;
    }
    bump((value) => value + 1);
  });
  return <AdaptiveScreen state={controller.snapshot()} size={{ columns, rows }} />;
}
