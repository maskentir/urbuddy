import { renderToString } from "ink";
import { cleanup, render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { concepts, initialState, type LabState, LabScreen, MeetingLab, press } from "./lab.js";
import { END_AT, JOIN_AT, replayAt } from "./model.js";
import { cards, chapters, events, participants } from "./scenario.js";

const sizes = [
  { columns: 58, rows: 22 },
  { columns: 86, rows: 28 },
  { columns: 120, rows: 33 },
] as const;
const checkpoints = [
  ...Array.from(new Set(events.map(({ at }) => at)), (at) => ({ at, keys: "" })),
  { at: 0, keys: "" },
  { at: 183, keys: "c" },
  { at: 316, keys: "" },
  { at: 428, keys: "" },
  { at: 445, keys: "c" },
  { at: 605, keys: "rd" },
  { at: 624, keys: "rd" },
  { at: 800, keys: "" },
  { at: 842, keys: "c" },
  { at: 1156, keys: "c" },
  { at: 1210, keys: "i" },
  { at: 1334, keys: "" },
  { at: 1363, keys: "i" },
  { at: 1530, keys: "c" },
  { at: 1_800, keys: "v" },
  { at: 1_800, keys: "la" },
];

function scenarioState(at: number, keys: string): LabState {
  return Array.from(keys).reduce((state, key) => press(state, key), initialState(at));
}

afterEach(cleanup);

describe("shared meeting evidence", () => {
  it("keeps the nine time ranges, material stress events and grounding references", () => {
    expect(participants).toHaveLength(5);
    expect(chapters.map(({ at }) => at)).toEqual([
      0, 180, 420, 600, 780, 1_020, 1_200, 1_440, 1_680,
    ]);
    const eventTimes = events.map(({ at }) => at);
    expect(eventTimes).toEqual(eventTimes.toSorted((a, b) => a - b));
    expect(events.at(-1)).toMatchObject({ kind: "close", at: END_AT });
    const utterances = events.filter((event) => event.kind === "utterance");
    expect(utterances.filter(({ at }) => at < JOIN_AT)).toHaveLength(3);
    expect(utterances.some(({ language }) => language === "mixed")).toBe(true);
    expect(utterances.some(({ overlap }) => overlap)).toBe(true);
    expect(utterances.some(({ speakerUncertain }) => speakerUncertain)).toBe(true);
    for (const card of cards) {
      for (const id of card.evidence) {
        expect(
          utterances.some(
            (event) => event.id === id && event.final && event.at >= JOIN_AT && event.at <= card.at,
          ),
        ).toBe(true);
      }
    }
    expect(replayAt(events, JOIN_AT).rows).toHaveLength(0);
  });

  it("preserves source corrections while rejecting late wrong-revision and superseded translations", () => {
    const before = replayAt(events, 429);
    expect(
      before.rows.find(({ speech }) => speech.id === "migration-correction")?.speech,
    ).toMatchObject({ final: false, revision: 1 });
    const corrected = replayAt(events, 445);
    expect(corrected.rows.find(({ speech }) => speech.id === "migration-correction")).toMatchObject(
      { speech: { final: true, revision: 2 }, translation: { revision: 2 } },
    );
    expect(corrected.rejected).toBe(1);
    const beforeReversal = replayAt(events, 1_435);
    expect(
      beforeReversal.rows.find(({ speech }) => speech.id === "assertion")?.supersededBy,
    ).toBeUndefined();
    const after = replayAt(events, 1_530);
    expect(after.rows.find(({ speech }) => speech.id === "assertion")).toMatchObject({
      supersededBy: "decision",
    });
    expect(after.rows.find(({ speech }) => speech.id === "assertion")?.translation).toBeUndefined();
    expect(after.rows.find(({ speech }) => speech.id === "decision")?.speech.text).toContain(
      "Monday 10:00 WIB",
    );
    expect(after.rejected).toBe(3);
    expect(after.coverage.map(({ kind }) => kind)).toEqual([
      "gap",
      "reconnect",
      "gap",
      "reconnect",
    ]);
  });
});

describe.each(concepts)("%s", (concept) => {
  it.each(sizes)("keeps task checkpoints within $columns × $rows", (size) => {
    for (const checkpoint of checkpoints) {
      const state = scenarioState(checkpoint.at, checkpoint.keys);
      const text = stripAnsi(
        renderToString(<LabScreen {...size} state={state} concept={concept} />, {
          columns: size.columns,
        }),
      );
      const lines = text.trimEnd().split("\n");
      expect(lines.length, `rows at ${JSON.stringify(checkpoint)}`).toBeLessThanOrEqual(size.rows);
      expect(
        Math.max(...lines.map((line) => Array.from(line).length)),
        `columns at ${JSON.stringify(checkpoint)}`,
      ).toBeLessThanOrEqual(size.columns);
      expect(text).toContain("q Quit");
    }
  });

  it("exercises real key handling for catch-up, draft, and privacy", async () => {
    const app = render(
      <MeetingLab concept={concept} start={605} play={false} speed={12} size={sizes[1]} />,
    );
    const frame = () => stripAnsi(app.lastFrame() ?? "");
    app.stdin.write("c");
    await vi.waitFor(() => expect(frame()).toContain("Recovery point 10:05"));
    app.stdin.write("r");
    await vi.waitFor(() => expect(frame()).toContain("Unclear addressee"));
    expect(frame()).not.toContain("Did you want me to answer?");
    app.stdin.write("d");
    await vi.waitFor(() => expect(frame()).toContain("Did you want me to answer?"));
    expect(frame()).toContain("no message sent");
    app.stdin.write("e");
    await vi.waitFor(() => expect(frame()).toContain("question@0"));
    app.stdin.write("e");
    await vi.waitFor(() => expect(frame()).toContain("question-overlap@0"));
    app.stdin.write("i");
    await vi.waitFor(() => expect(frame()).toContain("nothing, offline replay"));
    expect(frame()).toContain("pins are temporary");
  });
});

it("keeps history selection stable while the running clock receives new speech", async () => {
  const app = render(
    <MeetingLab concept="attention" start={783} play={false} speed={30} size={sizes[1]} />,
  );
  const frame = () => stripAnsi(app.lastFrame() ?? "");
  app.stdin.write("h");
  await vi.waitFor(() => expect(frame()).toContain("burst-1@0"));
  app.stdin.write("p");
  await vi.waitFor(() => expect(frame()).toContain("TEMPORARY PIN · burst-1"));
  app.stdin.write(" ");
  await vi.waitFor(() => expect(frame()).toMatch(/[1-9] new since opening/));
  expect(frame()).toContain("burst-1@0");
  app.stdin.write("f");
  await vi.waitFor(() => expect(frame()).toContain("FOLLOW · CURRENT TRANSCRIPT"));
});

it("preserves review and learning gates and shows the append-only deadline correction", () => {
  const show = (state: LabState) =>
    stripAnsi(
      renderToString(<LabScreen concept="attention" columns={120} rows={33} state={state} />, {
        columns: 120,
      }),
    );
  expect(show(scenarioState(1_790, "v"))).toContain("Available at meeting closure");
  expect(show(scenarioState(1_800, "v"))).toContain("09:00 WIB");
  expect(show(scenarioState(1_494, ""))).toContain("noon Sunday—sorry, noon Monday");
  expect(show(scenarioState(1_800, "l"))).not.toContain("Answer: no");
  expect(show(scenarioState(1_800, "la"))).toContain("Answer: no");
});

it("keeps a pinned old decision in history and visibly supersedes it on reversal", () => {
  const atClaim = scenarioState(482, "hp");
  const after = { ...atClaim, at: 1_530 };
  const text = stripAnsi(
    renderToString(<LabScreen concept="attention" columns={120} rows={33} state={after} />, {
      columns: 120,
    }),
  );
  expect(text).toContain("SUPERSEDED");
  expect(text).toContain("Updated by decision");
  expect(text).toContain("TEMPORARY PIN · assertion");
  expect(text).not.toContain("Rencana sementara Jumat");
});

it("requires explicit reveal for a new response after the addressee becomes clear", () => {
  const draftedUnknown = scenarioState(605, "rd");
  const changed = { ...draftedUnknown, at: 624 };
  const show = (state: LabState) =>
    stripAnsi(
      renderToString(<LabScreen concept="attention" columns={86} rows={28} state={state} />, {
        columns: 86,
      }),
    );
  expect(show(draftedUnknown)).toContain("Did you want me to answer?");
  expect(show(changed)).toContain("The CTO asks Sari");
  expect(show(changed)).not.toContain("I'd wait");
  expect(show(press(changed, "d"))).toContain("I'd wait");
});
