import { describe, expect, test } from "vitest";

import { evaluate, type TraceRow } from "./evaluate.js";
import { alignWords, normalizeWords, NORMALIZATION_POLICY_VERSION } from "./word-alignment.js";

const REFERENCE_TURN_TEXT = [
  "The export finished, but replication lag is still above two minutes.",
  "Can we bump the connection pool limit before the next batch?",
  "Sure, but the pool saturates when the vacuum and the reindex overlap.",
  "Actually, correction. Saturation starts earlier; the write ahead log backs up first.",
  "Then the compaction lease is held by the stale replica, so the tombstone sweep waits.",
  "Understood. I will cap the vacuum window and watch p99 latency.",
];

const FIRST_RUN_ACTUAL = [
  "The export finished but replication lag is still above two minutes",
  "Can we bump the connection pool limit before the next batch?",
  "Sure, but the pool saturates when the vacuum and the reindex overlap. Actually, correction, saturation starts earlier the right ahead log backs up first.",
  "Then the compaction leases held by the stale replica so the tombstone sweep waits.",
  "Understood, I will cap the vacuum window and watch page 99",
];

const REFERENCE = {
  fixtureId: "muse-qualification-01",
  technicalTerms: [
    "replication lag",
    "connection pool",
    "vacuum",
    "reindex",
    "write ahead log",
    "compaction lease",
    "tombstone sweep",
    "p99 latency",
  ],
  turns: REFERENCE_TURN_TEXT.map((text, index) => ({ id: `t${index + 1}`, text })),
  referenceTranscript: REFERENCE_TURN_TEXT.join(" "),
};

const MANIFEST = {
  sampleRate: 16_000,
  spans: Object.fromEntries(
    REFERENCE_TURN_TEXT.map((_, index) => [
      `t${index + 1}`,
      { startMs: index * 5_000, durationMs: 4_000 },
    ]),
  ),
};

function traceRow(
  kind: string,
  monoMs: number,
  data?: Readonly<Record<string, unknown>>,
  detail = "",
): TraceRow {
  return {
    kind,
    monoMs,
    elapsedMs: monoMs,
    detail,
    ...(data === undefined ? {} : { data }),
  };
}

describe("normalization policy norm-v2", () => {
  test("sentence punctuation is removed from token edges", () => {
    expect(normalizeWords("Hello, world.")).toEqual(["hello", "world"]);
    expect(normalizeWords("Really?! Yes.")).toEqual(["really", "yes"]);
  });

  test("technical and numeric punctuation inside a token is preserved", () => {
    expect(normalizeWords("3.5 ms, 50% and 24/7 at c++ or node.js, p99.")).toEqual([
      "3.5",
      "ms",
      "50%",
      "and",
      "24/7",
      "at",
      "c++",
      "or",
      "node.js",
      "p99",
    ]);
  });

  test("apostrophes inside a word are removed", () => {
    expect(normalizeWords("don't stop")).toEqual(["dont", "stop"]);
  });

  test("the policy version is explicit", () => {
    expect(NORMALIZATION_POLICY_VERSION).toBe("norm-v2");
  });
});

describe("word alignment accounting", () => {
  test("identical text with different punctuation has no edits", () => {
    const alignment = alignWords(
      normalizeWords("The export finished, but replication lag is high."),
      normalizeWords("The export finished but replication lag is high"),
    );
    expect(alignment.edits.editDistance).toBe(0);
    expect(alignment.edits.substitutions).toHaveLength(0);
    expect(alignment.edits.deletions).toHaveLength(0);
    expect(alignment.edits.insertions).toHaveLength(0);
  });

  test("a substitution only is counted once", () => {
    const alignment = alignWords(["write", "ahead"], ["right", "ahead"]);
    expect(alignment.edits.substitutions).toHaveLength(1);
    expect(alignment.edits.substitutions[0]?.reference).toBe("write");
    expect(alignment.edits.substitutions[0]?.hypothesis).toBe("right");
    expect(alignment.edits.deletions).toHaveLength(0);
    expect(alignment.edits.insertions).toHaveLength(0);
    expect(alignment.edits.editDistance).toBe(1);
  });

  test("a deletion only is counted once", () => {
    const alignment = alignWords(["the", "lease", "is"], ["the", "lease"]);
    expect(alignment.edits.substitutions).toHaveLength(0);
    expect(alignment.edits.deletions).toEqual(["is"]);
    expect(alignment.edits.insertions).toHaveLength(0);
    expect(alignment.edits.editDistance).toBe(1);
  });

  test("an insertion only is counted once", () => {
    const alignment = alignWords(["the", "lease"], ["the", "stale", "lease"]);
    expect(alignment.edits.substitutions).toHaveLength(0);
    expect(alignment.edits.deletions).toHaveLength(0);
    expect(alignment.edits.insertions).toEqual(["stale"]);
    expect(alignment.edits.editDistance).toBe(1);
  });

  test("combined edits keep separate counts and satisfy the distance invariant", () => {
    const alignment = alignWords(["the", "lease", "is", "held"], ["the", "leases", "held"]);
    expect(alignment.edits.substitutions).toHaveLength(1);
    expect(alignment.edits.deletions).toHaveLength(1);
    expect(alignment.edits.insertions).toHaveLength(0);
    expect(alignment.edits.editDistance).toBe(
      alignment.edits.substitutions.length +
        alignment.edits.deletions.length +
        alignment.edits.insertions.length,
    );
  });

  test("empty transcripts produce no edits and no division by zero", () => {
    const alignment = alignWords([], []);
    expect(alignment.edits.editDistance).toBe(0);
    const emptyReference = { ...REFERENCE, turns: [], referenceTranscript: "" };
    const report = evaluate([], MANIFEST, emptyReference);
    expect(report.wordErrorRate).toBe(0);
    const missingEverything = evaluate([], MANIFEST, REFERENCE);
    expect(missingEverything.wordErrorRate).toBe(1);
  });
});

describe("first run transcript", () => {
  const trace: TraceRow[] = [
    traceRow("final-committed", 1_000, {
      turn: "1",
      utteranceId: "epoch-0-turn-1",
      revision: 3,
      text: FIRST_RUN_ACTUAL[0] ?? "",
    }),
    traceRow("final-committed", 2_000, {
      turn: "2",
      utteranceId: "epoch-0-turn-2",
      revision: 3,
      text: FIRST_RUN_ACTUAL[1] ?? "",
    }),
    traceRow("final-committed", 3_000, {
      turn: "3",
      utteranceId: "epoch-0-turn-3",
      revision: 3,
      text: FIRST_RUN_ACTUAL[2] ?? "",
    }),
    traceRow("final-committed", 4_000, {
      turn: "4",
      utteranceId: "epoch-0-turn-4",
      revision: 3,
      text: FIRST_RUN_ACTUAL[3] ?? "",
    }),
    traceRow("final-committed", 5_000, {
      turn: "5",
      utteranceId: "epoch-0-turn-5",
      revision: 3,
      text: FIRST_RUN_ACTUAL[4] ?? "",
    }),
  ];

  test("the corrected counts match the independent review", () => {
    const report = evaluate(trace, MANIFEST, REFERENCE);
    expect(report.normalizationPolicy).toBe("norm-v2");
    expect(report.referenceWords).toBe(72);
    expect(report.edits.substitutions).toHaveLength(4);
    expect(report.edits.deletions).toHaveLength(1);
    expect(report.edits.insertions).toHaveLength(0);
    expect(report.edits.editDistance).toBe(5);
    expect(report.wordErrorRate).toBeCloseTo(0.06944, 5);
  });

  test("the substitution pairs are preserved", () => {
    const report = evaluate(trace, MANIFEST, REFERENCE);
    const pairs = report.edits.substitutions.map(
      (entry) => `${entry.reference}->${entry.hypothesis}`,
    );
    expect(pairs).toContain("write->right");
    expect(pairs).toContain("p99->page");
    expect(pairs).toContain("latency->99");
    expect(pairs.filter((pair) => pair.includes("leases"))).toHaveLength(1);
  });

  test("the merged provider turn is detected and reported", () => {
    const report = evaluate(trace, MANIFEST, REFERENCE);
    const merged = report.providerTurns.find((turn) => turn.status === "merged");
    expect(merged).toBeDefined();
    expect(merged?.referenceSegments).toEqual(["t3", "t4"]);
    expect(report.missingSegments).toEqual([]);
  });

  test("technical term accuracy and meaning changes are separated from the WER", () => {
    const report = evaluate(trace, MANIFEST, REFERENCE);
    expect(report.technicalTermAccuracy).toBeCloseTo(0.75, 5);
    expect(report.meaningChanges.join(" ")).toContain("write ahead log");
    expect(report.meaningChanges.join(" ")).toContain("p99 latency");
  });

  test("metrics that the legacy trace cannot establish are unavailable", () => {
    const report = evaluate(trace, MANIFEST, REFERENCE);
    expect(report.latency.firstPartial.count).toBe(0);
    expect(report.latency.endOfSpeechToFinal.count).toBe(0);
    expect(report.latency.providerEventToRender.count).toBe(0);
    expect(report.unavailable.length).toBeGreaterThan(0);
  });
});

describe("turn alignment negative controls", () => {
  function finalsOf(texts: readonly string[]): TraceRow[] {
    return texts.map((text, index) =>
      traceRow("final-committed", 1_000 + index * 100, {
        turn: String(index + 1),
        utteranceId: `epoch-0-turn-${index + 1}`,
        revision: 1,
        text,
      }),
    );
  }

  test("a provider turn that merges two reference segments is marked merged", () => {
    const trace = finalsOf([
      "The export finished but replication lag is still above two minutes",
      "Can we bump the connection pool limit before the next batch?",
      "Sure but the pool saturates when the vacuum and the reindex overlap. Actually correction saturation starts earlier the write ahead log backs up first.",
      "Then the compaction lease is held by the stale replica so the tombstone sweep waits",
      "Understood I will cap the vacuum window and watch p99 latency",
    ]);
    const report = evaluate(trace, MANIFEST, REFERENCE);
    const merged = report.providerTurns.find((turn) => turn.status === "merged");
    expect(merged).toBeDefined();
    expect(merged?.referenceSegments).toEqual(["t3", "t4"]);
    expect(report.missingSegments).toEqual([]);
  });

  test("a reference segment split across provider turns is marked split and its latency is unavailable", () => {
    const trace = finalsOf([
      "The export finished but",
      "replication lag is still above two minutes",
      "Can we bump the connection pool limit before the next batch?",
      "Sure but the pool saturates when the vacuum and the reindex overlap",
      "Actually correction saturation starts earlier the write ahead log backs up first",
      "Then the compaction lease is held by the stale replica so the tombstone sweep waits",
      "Understood I will cap the vacuum window and watch p99 latency",
    ]);
    const report = evaluate(trace, MANIFEST, REFERENCE);
    const split = report.segmentAlignment.find((segment) => segment.status === "split");
    expect(split).toBeDefined();
    expect(split?.providerTurns).toEqual(["1", "2"]);
    const turn = report.providerTurns.find((entry) => entry.turn === "1");
    expect(turn?.status).toBe("split");
    expect(turn?.firstPartialMs).toBeUndefined();
    expect(report.unavailable.join(" ")).toContain("split");
  });

  test("an inserted provider turn is reported without a reference segment", () => {
    const trace = finalsOf([
      "The export finished but replication lag is still above two minutes",
      "Can we bump the connection pool limit before the next batch?",
      "Sure but the pool saturates when the vacuum and the reindex overlap",
      "Actually correction saturation starts earlier the write ahead log backs up first",
      "Then the compaction lease is held by the stale replica so the tombstone sweep waits",
      "Understood I will cap the vacuum window and watch p99 latency",
      "Zzzz qqqq wwww",
    ]);
    const report = evaluate(trace, MANIFEST, REFERENCE);
    expect(report.insertedTurns).toEqual(["7"]);
    const inserted = report.providerTurns.find((turn) => turn.turn === "7");
    expect(inserted?.status).toBe("inserted");
    expect(inserted?.firstPartialMs).toBeUndefined();
  });

  test("a missing reference segment is reported", () => {
    const trace = finalsOf([
      "The export finished but replication lag is still above two minutes",
      "Can we bump the connection pool limit before the next batch?",
      "Sure but the pool saturates when the vacuum and the reindex overlap",
      "Actually correction saturation starts earlier the write ahead log backs up first",
      "Then the compaction lease is held by the stale replica so the tombstone sweep waits",
    ]);
    const report = evaluate(trace, MANIFEST, REFERENCE);
    expect(report.missingSegments).toEqual(["t6"]);
  });
});

describe("integrity gates", () => {
  test("the gates report the observable state of the run", () => {
    const trace: TraceRow[] = [
      traceRow("session-initiation", 0),
      traceRow("websocket-established", 100),
      traceRow("audio-sent", 200, { cumulativeFrames: 1_920, bytes: 3_840 }),
      traceRow("audio-sent", 300, { cumulativeFrames: 3_840, bytes: 3_840 }),
      traceRow("provider-summary", 400, {
        providerId: "muse",
        modelId: "muse-voice-transcribe-1.0",
      }),
      traceRow("shutdown", 500, {
        code: 0,
        sourceFrames: 3_840,
        transmittedFrames: 3_840,
        discontinuities: 0,
        stale: 0,
        duplicates: 0,
      }),
    ];
    const report = evaluate(trace, MANIFEST, REFERENCE);
    expect(report.integrity.completeAudioTransmission).toBe(true);
    expect(report.integrity.providerEndAcknowledged).toBe(true);
    expect(report.integrity.unexpectedDiscontinuities).toBe(0);
    expect(report.integrity.staleCanonicalState).toBe(0);
    expect(report.integrity.duplicateCanonicalState).toBe(0);
    expect(report.integrity.cleanShutdown).toBe(true);
    expect(report.integrity.referenceInjectedIntoRuntime).toBe(false);
    expect(report.integrity.transcriptCorrectionApplied).toBe(false);
  });

  test("an incomplete transmission is reported instead of passing", () => {
    const trace: TraceRow[] = [
      traceRow("shutdown", 500, {
        code: 0,
        sourceFrames: 4_720,
        transmittedFrames: 4_608,
        discontinuities: 1,
      }),
    ];
    const report = evaluate(trace, MANIFEST, REFERENCE);
    expect(report.integrity.completeAudioTransmission).toBe(false);
    expect(report.integrity.unexpectedDiscontinuities).toBe(1);
  });
});
