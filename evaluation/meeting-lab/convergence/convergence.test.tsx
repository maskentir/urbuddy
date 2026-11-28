import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Conversation, ConversationScreen } from "./screen.js";
import {
  act,
  advance,
  DEFAULT_ROLES,
  evidenceIds,
  HISTORY_LIMIT,
  initial,
  newContext,
  responseFor,
  type Session,
  sceneAt,
  translationStatus,
} from "./session.js";

const standard = { columns: 86, rows: 28 };
const compact = { columns: 58, rows: 22 };
const short = { columns: 44, rows: 11 };
const wide = { columns: 120, rows: 33 };

function keys(state: Session, ...inputs: string[]): Session {
  return inputs.reduce(act, state);
}

function frame(state: Session, size = standard, roles = DEFAULT_ROLES): string {
  return stripAnsi(
    renderToString(<ConversationScreen {...{ state, size, roles }} />, { columns: size.columns }),
  );
}
function draft(at: number, expanded = false): Session {
  return keys(initial(at, expanded), "r", "d");
}

describe("conversation and recovery", () => {
  it("opens delayed translation from the retained viewport without changing the source order", () => {
    const before = sceneAt(333);
    const selected = before.retained.find(({ speech }) => speech.id === "race");
    expect(selected && translationStatus(selected)).toBe("pending");
    expect(before.recent.some(({ speech }) => speech.id === "race")).toBe(false);
    const live = advance(initial(333), 334);
    expect(sceneAt(334).retained.map(({ speech }) => speech.id)).toEqual(
      before.retained.map(({ speech }) => speech.id),
    );
    expect(frame(live)).toContain("t Terjemahan");
    const opened = act(live, "t");
    expect(opened.selected).toBe("race");
    expect(frame(opened)).toContain("Dua worker dapat membaca key");
    expect(frame(opened)).not.toContain("Two workers can read");
    expect(frame(act(opened, "o"))).toContain("Two workers can read");
    expect(opened.understood).toBeUndefined();
  });

  it("keeps a correction on the same viewed source and excludes its superseded translation", () => {
    const reading = keys(initial(789), "h");
    expect(reading.selected).toBe("burst-3");
    expect(frame(reading)).toContain("Ship it to all partners—");
    const corrected = advance(reading, 829);
    expect(corrected.selected).toBe("burst-3");
    expect(frame(corrected)).toContain("not all; only the pilot cohort.");
    expect(frame(corrected)).not.toContain("Rilis untuk semua partner");
    const translated = advance(corrected, 842);
    expect(frame(translated)).toContain("Rilis hanya untuk kelompok pilot");
    expect(translated.understood).toBeUndefined();
  });

  it("distinguishes failure, pending, translated and unknown coverage", () => {
    const status = (at: number, id: string) => {
      const row = sceneAt(at).retained.find(({ speech }) => speech.id === id);
      return row && translationStatus(row);
    };
    expect(status(334, "race")).toBe("translated");
    expect(status(333, "race")).toBe("pending");
    expect(status(333, "same-key")).toBe("unknown");
    expect(status(1205, "request-link")).toBe("unavailable");
    expect(frame(act(initial(1210), "h"))).toContain("Terjemahan tidak tersedia");
  });

  it("keeps a stable selection while the bounded history advances, including eviction", () => {
    let state = keys(initial(183), "h", "m");
    state = advance(state, 334);
    expect(state.selected).toBe("join");
    expect(state.lastViewed?.id).toBe("join");
    state = advance(state, 445);
    expect(sceneAt(state.at).retained).toHaveLength(HISTORY_LIMIT);
    expect(state.selected).toBe("join");
    expect(frame(state)).toContain("Bukti join tidak tersedia");
    const recovered = frame(keys(state, "esc", "c"));
    expect(recovered).toContain("Terakhir dipahami · 03:03");
    expect(recovered).toContain("Terakhir dilihat · 07:05");
    expect(recovered).toContain("Titik pemulihan di luar riwayat");
    expect(recovered).toContain("04:20–07:10");
  });

  it("preserves recap provenance while explaining unavailable pre-join sources", () => {
    const note = keys(initial(180), "c", "e");
    expect(frame(note)).toContain("Rujukan recap");
    expect(frame(note)).toContain("Bukti opening-1 tidak tersedia");
    expect(frame(note)).not.toContain("Checkout retry is the only release blocker");
    expect(frame(act(note, "right"))).toContain("Bukti opening-2 tidak tersedia");
    expect(act(note, "c").view).toBe("catchup");
  });
});

describe("response evidence", () => {
  it("keeps the ambiguous question and its draft stable across a changed question", () => {
    const old = draft(605);
    expect(frame(old)).toContain("Belum jelas: Leo atau Sari.");
    expect(frame(old)).toContain("EN · Did you want me to answer?");
    expect(frame(old)).toContain("ID · Apakah pertanyaan itu untuk saya?");
    expect(frame(act(old, "o"))).toContain("Can you tell us whether we can flip the flag");
    const changed = advance(old, 644);
    expect(responseFor(changed)?.id).toBe("question");
    expect(frame(changed)).toContain("Draft usang · konteks baru");
    expect(frame(changed)).toContain("EN · Did you want me to answer?");
    expect(act(changed, "n").question).toBe("go-question");
  });

  it("flags a failed migration and preserves notes and evidence while the next speaker asks a question", () => {
    const noted = keys(draft(644), "x", "input:Wait for staging.", "enter");
    let state = advance(noted, 662);
    expect(frame(state)).toContain("Draft usang · migrasi gagal");
    expect(frame(state)).toContain("Migrasi gagal. Jangan deploy.");
    expect(frame(state)).toContain("Wait for staging.");
    expect(evidenceIds(state)).toEqual(["go-question", "unrun", "rollback", "migration-failed"]);
    state = keys(state, "e", "right");
    expect(frame(state)).toContain("Rujukan draft");
    state = advance(state, 674);
    expect(frame(state)).toContain("Draft usang · migrasi gagal");
    state = keys(state, "right", "right");
    expect(frame(state)).toContain("Konteks baru · tinjau terpisah");
    expect(frame(state)).toContain("Migrasi gagal. Jangan deploy.");
    state = keys(state, "r");
    expect(state.question).toBe("go-question");
    expect(state.revealed).toBe(true);
    expect(state.text).toBe("Wait for staging.");
    expect(act(state, "esc").view).toBe("follow");
    const other = keys(state, "n", "d");
    expect(frame(other)).toContain("Pertanyaan untuk Leo.");
    expect(frame(other)).toContain("Tidak ada draft untuk pembicara lain");
    expect(frame(other)).not.toContain("Proceed with the pilot");
  });

  it("refuses a draft for an unrelated utterance picked from history", () => {
    const wrong = keys(draft(605), "h", "r", "d");
    expect(frame(wrong)).toContain("Ucapan question-overlap tidak memiliki pertanyaan");
    expect(frame(wrong)).not.toContain("Did you want me to answer");
    expect(keys(wrong, "esc", "r").question).toBe("question");
  });

  it("keeps language roles configurable for the authored bilingual fixture", () => {
    const switched = frame(draft(605), standard, { comprehension: "en", reply: "id" });
    expect(switched).toContain("Can we turn the flag on safely today?");
    expect(switched).toContain("ID · Apakah pertanyaan itu untuk saya?");
    expect(switched).toContain("EN · Did you want me to answer?");
  });
});

describe("viewport and terminal input", () => {
  afterEach(cleanup);

  it.each([short, compact, standard, wide])(
    "bounds follow, response, outage and long drafts at $columns × $rows",
    (size) => {
      const cases = [
        initial(605, true),
        draft(605, true),
        draft(644, true),
        advance(draft(644), 660),
        keys(initial(675), "h"),
        initial(1210),
        keys(draft(605), "e"),
        keys(advance(draft(644), 1210), "i", "c"),
        keys(initial(1530), "c"),
        keys(initial(1800), "v"),
      ];
      for (const state of cases) {
        const text = frame(state, size);
        expect(
          text.trimEnd().split("\n").length,
          `${state.view} at ${state.at}`,
        ).toBeLessThanOrEqual(size.rows);
        expect(text).toContain("Simulasi offline");
        expect(text).toContain("0 kirim/simpan");
      }
      const unicode = frame(keys(initial(675), "h"), size);
      expect(unicode.replace(/\s+/gu, "")).toContain("ロールバック");
      expect(unicode).toContain("👩🏽‍💻");
      const segmenter = new Intl.Segmenter("id", { granularity: "grapheme" });
      for (const line of unicode.split("\n")) {
        const cells = Array.from(segmenter.segment(line), ({ segment }) => segment).reduce(
          (sum, value) =>
            sum + (/^[\p{Extended_Pictographic}\p{Script=Katakana}ー]/u.test(value) ? 2 : 1),
          0,
        );
        expect(cells).toBeLessThanOrEqual(size.columns);
      }
    },
  );

  it("keeps the outage and stale-draft warnings above content in every task view", () => {
    const state = advance(draft(644), 1210);
    for (const key of ["f", "c", "r", "e", "h", "t", "v", "l", "?"]) {
      const text = frame(act(state, key), short);
      expect(text).toContain("Gap aktif");
      expect(text).toContain("ID gagal");
      expect(text).toContain("Draft usang · migrasi gagal");
    }
    expect(newContext(state).some(({ id }) => id === "migration-failed")).toBe(true);
  });

  it("scrolls wrapped draft text through Ink without moving persistent status", async () => {
    const app = render(
      <Conversation
        start={644}
        wide={false}
        play={false}
        speed={12}
        roles={DEFAULT_ROLES}
        size={short}
      />,
    );
    const output = () => stripAnsi(app.lastFrame() ?? "");
    app.stdin.write("r");
    await vi.waitFor(() => expect(output()).toContain("Pertanyaan dipilih"));
    app.stdin.write("d");
    await vi.waitFor(() => expect(output()).toContain("Usulan simulasi"));
    for (let i = 0; i < 12; i++) {
      app.stdin.write("\x1b[B");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await vi.waitFor(() => expect(output()).toContain("hasil yang masih ditunggu."));
    expect(output()).toContain("Simulasi offline");
    expect(output().trimEnd().split("\n").length).toBeLessThanOrEqual(short.rows);
  });

  it("retains live typed content across resizing, keeps Unicode graphemes, and escapes to Follow", async () => {
    const node = (size: typeof short) => (
      <Conversation start={644} wide play={false} speed={12} roles={DEFAULT_ROLES} size={size} />
    );
    const app = render(node(wide));
    const output = () => stripAnsi(app.lastFrame() ?? "");
    app.stdin.write("r");
    await vi.waitFor(() => expect(output()).toContain("Terkini"));
    app.stdin.write("x");
    await vi.waitFor(() => expect(output()).toContain("Catatan Anda"));
    app.stdin.write("retro cafe\u0301 👩🏽‍💻");
    await vi.waitFor(() => expect(output()).toContain("café 👩🏽‍💻"));
    app.rerender(node(short));
    await vi.waitFor(() => expect(output()).not.toContain("Terkini"));
    expect(output()).toContain("café 👩🏽‍💻");
    app.stdin.write("\u007f");
    await vi.waitFor(() => expect(output()).not.toContain("👩"));
    app.stdin.write("ロールバック");
    await vi.waitFor(() => expect(output()).toContain("ロールバック"));
    app.stdin.write("\x1b");
    await vi.waitFor(() => expect(output()).toContain("URBUDDY · IKUTI"));
    app.stdin.write("r");
    await vi.waitFor(() => expect(output()).toContain("café ロールバック"));
  });
});
