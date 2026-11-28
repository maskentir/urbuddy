import type { Caption, CaptionSnapshot } from "@modules/session/captions";
import { TerminalSurface, type TerminalState } from "@presentation/terminal";
import { renderToString } from "ink";
import { describe, expect, test, vi } from "vitest";

function row(id: string, text: string, translation: Caption["translation"], final = true): Caption {
  return { id, revision: 1, text, final, atMs: 1, translation };
}

function makeState(snapshot: CaptionSnapshot, extra: Partial<TerminalState> = {}): TerminalState {
  return {
    snapshot,
    selectedId: undefined,
    original: false,
    diagnostics: false,
    expired: false,
    ...extra,
  };
}

function makeSnapshot(
  rows: readonly Caption[],
  extra: Partial<CaptionSnapshot> = {},
): CaptionSnapshot {
  return { rows, gaps: 0, dropped: 0, status: "running", ...extra };
}

describe("production terminal surface", () => {
  test("keeps source visible until a committed translation exists", () => {
    const output = renderToString(
      <TerminalSurface
        state={makeState(
          makeSnapshot([
            row("one", "Ready", { state: "committed", text: "Siap", uncertain: false }),
            row("two", "Processing", { state: "pending" }, false),
            row("three", "Failed source", { state: "failed", reason: "provider unavailable" }),
            row("four", "Old source", { state: "superseded" }),
            row("unavailable", "Untranslated source", { state: "unavailable" }),
            row("five", "Maybe", { state: "provisional", text: "Mungkin", uncertain: true }),
          ]),
        )}
        onAction={vi.fn()}
      />,
    );
    expect(output).toContain("Siap");
    expect(output).toContain("Processing …");
    expect(output).toContain("Failed source · translation failed");
    expect(output).toContain("Old source · translation superseded");
    expect(output).toContain("Untranslated source · translation unavailable");
    expect(output).toContain("Mungkin · coverage uncertain · provisional");
    expect(output).not.toContain("Ready");
  });

  test("renders diagnostics, gaps, and expired history honestly", () => {
    const output = renderToString(
      <TerminalSurface
        state={makeState(
          makeSnapshot([], {
            gaps: 2,
            dropped: 3,
            lastGap: "reconnect",
            status: "failed",
            detail: "Muse disconnected",
          }),
          { diagnostics: true, expired: true },
        )}
        onAction={vi.fn()}
      />,
    );
    expect(output).toContain("2 source gaps");
    expect(output).toContain("3 history rows expired");
    expect(output).toContain("reconnect");
    expect(output).toContain("Muse disconnected");
    expect(output).toContain("history item expired");
  });

  test("uses a selected history window instead of the live tail", () => {
    const rows = Array.from({ length: 80 }, (_, index) =>
      row(`${index}`, `Source ${index}`, { state: "pending" }),
    );
    const output = renderToString(
      <TerminalSurface
        state={makeState(makeSnapshot(rows), { selectedId: "10" })}
        onAction={vi.fn()}
      />,
    );
    expect(output).toContain("› Source 10 · translation pending");
    expect(output).not.toContain("Source 79");
  });
});
