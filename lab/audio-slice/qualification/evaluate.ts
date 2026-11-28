import { readFileSync } from "node:fs";

export interface TraceRow {
  readonly kind: string;
  readonly monoMs: number;
  readonly elapsedMs: number;
  readonly detail: string;
}

export interface ManifestSpan {
  readonly startMs: number;
  readonly durationMs: number;
}

export interface ReferenceFixture {
  readonly provenance: string;
  readonly technicalTerms: readonly string[];
  readonly turns: readonly { readonly id: string; readonly text: string }[];
  readonly referenceTranscript: string;
}

export interface WordEdits {
  readonly deletions: readonly string[];
  readonly insertions: readonly string[];
  readonly substitutions: number;
}

export interface TurnObservation {
  readonly segmentId: string;
  readonly referenceText: string;
  readonly firstPartialMs: number | undefined;
  readonly endOfSpeechToFinalMs: number | undefined;
  readonly providerEventToUiMs: number | undefined;
  readonly totalSourceToUiMs: number | undefined;
  readonly finalized: boolean;
  readonly partials: number;
  readonly finalText: string;
  readonly stable: boolean;
}

export interface LatencySummary {
  readonly count: number;
  readonly min: number | undefined;
  readonly p50: number | undefined;
  readonly p95: number | undefined;
  readonly max: number | undefined;
  readonly observations: readonly number[];
}

export interface EvaluationReport {
  readonly referenceTranscript: string;
  readonly actualTranscript: string;
  readonly referenceWords: number;
  readonly wordErrorRate: number;
  readonly edits: WordEdits;
  readonly technicalTerms: readonly { readonly term: string; readonly present: boolean }[];
  readonly technicalTermAccuracy: number;
  readonly meaningChanges: readonly string[];
  readonly turns: readonly TurnObservation[];
  readonly expectedTurns: number;
  readonly finalizedTurns: number;
  readonly missingFinals: number;
  readonly duplicatedFinals: number;
  readonly discontinuities: number;
  readonly latency: {
    readonly firstPartial: LatencySummary;
    readonly endOfSpeechToFinal: LatencySummary;
    readonly providerEventToUi: LatencySummary;
    readonly totalSourceToUi: LatencySummary;
  };
}

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[-–—]/g, " ")
    .replace(/[^a-z0-9%.]+/g, " ")
    .split(" ")
    .filter((word) => word.length > 0);
}

interface Cell {
  readonly cost: number;
  readonly operation: "match" | "substitute" | "delete" | "insert";
}

function align(
  reference: readonly string[],
  hypothesis: readonly string[],
): {
  readonly edits: WordEdits;
  readonly cost: number;
} {
  const rows = reference.length + 1;
  const columns = hypothesis.length + 1;
  const table: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => ({ cost: 0, operation: "match" as const })),
  );
  for (let row = 1; row < rows; row += 1) {
    table[row]![0] = { cost: row, operation: "delete" };
  }
  for (let column = 1; column < columns; column += 1) {
    table[0]![column] = { cost: column, operation: "insert" };
  }
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const referenceWord = reference[row - 1] ?? "";
      const hypothesisWord = hypothesis[column - 1] ?? "";
      const diagonal =
        table[row - 1]![column - 1]!.cost + (referenceWord === hypothesisWord ? 0 : 1);
      const deletion = table[row - 1]![column]!.cost + 1;
      const insertion = table[row]![column - 1]!.cost + 1;
      const best = Math.min(diagonal, deletion, insertion);
      const operation =
        best === diagonal
          ? referenceWord === hypothesisWord
            ? "match"
            : "substitute"
          : best === deletion
            ? "delete"
            : "insert";
      table[row]![column] = { cost: best, operation };
    }
  }
  const deletions: string[] = [];
  const insertions: string[] = [];
  let substitutions = 0;
  let row = reference.length;
  let column = hypothesis.length;
  while (row > 0 || column > 0) {
    const cell = table[row]![column]!;
    if (row > 0 && column > 0 && cell.operation !== "delete" && cell.operation !== "insert") {
      if (cell.operation === "substitute") {
        substitutions += 1;
        deletions.push(reference[row - 1] ?? "");
        insertions.push(hypothesis[column - 1] ?? "");
      }
      row -= 1;
      column -= 1;
      continue;
    }
    if (row > 0 && (column === 0 || cell.operation === "delete")) {
      deletions.push(reference[row - 1] ?? "");
      row -= 1;
      continue;
    }
    insertions.push(hypothesis[column - 1] ?? "");
    column -= 1;
  }
  return {
    edits: { deletions, insertions, substitutions },
    cost: table[rows - 1]![columns - 1]!.cost,
  };
}

function summarize(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      min: undefined,
      p50: undefined,
      p95: undefined,
      max: undefined,
      observations: [],
    };
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const p50 =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  const p95 =
    sorted.length < 20
      ? undefined
      : (sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0);
  return {
    count: sorted.length,
    min: sorted[0],
    p50,
    p95,
    max: sorted[sorted.length - 1],
    observations: sorted,
  };
}

function turnIdOf(detail: string): string | undefined {
  const match = detail.match(/turn=([^ ]+)/);
  return match?.[1];
}

export function evaluate(
  trace: readonly TraceRow[],
  manifest: { readonly spans: Record<string, ManifestSpan> },
  reference: ReferenceFixture,
): EvaluationReport {
  const providerEvents = trace.filter((row) => row.kind === "provider-event");
  const partialsByTurn = new Map<string, TraceRow[]>();
  const completedByTurn = new Map<string, TraceRow>();
  let currentTurn: string | undefined;
  for (const row of providerEvents) {
    const turn = turnIdOf(row.detail);
    if (row.detail.startsWith("turnStarted") && turn !== undefined) {
      currentTurn = turn;
      if (!partialsByTurn.has(turn)) partialsByTurn.set(turn, []);
    }
    if (row.detail.startsWith("partial")) {
      const bucket = partialsByTurn.get(currentTurn ?? "none") ?? [];
      bucket.push(row);
      partialsByTurn.set(currentTurn ?? "none", bucket);
    }
    if (row.detail.startsWith("completed") && turn !== undefined) {
      completedByTurn.set(turn, row);
    }
  }
  const canonicalFinals = trace.filter((row) => row.kind === "canonical-final");
  const renders = trace.filter((row) => row.kind === "render-observed");

  const completed = [...completedByTurn.values()].toSorted((a, b) => a.elapsedMs - b.elapsedMs);
  const segmentIds = Object.keys(manifest.spans).toSorted(
    (left, right) => (manifest.spans[left]?.startMs ?? 0) - (manifest.spans[right]?.startMs ?? 0),
  );

  const turns: TurnObservation[] = [];
  const actualParts: string[] = [];
  for (const [index, segmentId] of segmentIds.entries()) {
    const span = manifest.spans[segmentId];
    const providerTurn = completed[index];
    const partials =
      providerTurn === undefined
        ? []
        : (partialsByTurn.get(turnIdOf(providerTurn.detail) ?? "") ?? []);
    const firstPartial = partials[0];
    const canonical = canonicalFinals[index];
    const render =
      canonical === undefined
        ? undefined
        : renders.find((row) => row.elapsedMs >= canonical.elapsedMs);
    const finalText = canonical?.detail.split(": ").slice(1).join(": ") ?? "";
    if (finalText.length > 0) actualParts.push(finalText);
    turns.push({
      segmentId,
      referenceText: reference.turns[index]?.text ?? "",
      firstPartialMs:
        firstPartial === undefined || span === undefined
          ? undefined
          : firstPartial.elapsedMs - span.startMs,
      endOfSpeechToFinalMs:
        canonical === undefined || span === undefined
          ? undefined
          : canonical.elapsedMs - (span.startMs + span.durationMs),
      providerEventToUiMs:
        render === undefined || providerTurn === undefined
          ? undefined
          : render.elapsedMs - providerTurn.elapsedMs,
      totalSourceToUiMs:
        render === undefined || span === undefined ? undefined : render.elapsedMs - span.startMs,
      finalized: canonical !== undefined,
      partials: partials.length,
      finalText,
      stable:
        partials.length > 0 &&
        finalText.includes((partials[partials.length - 1]?.detail.split("text=")[1] ?? "").trim()),
    });
  }

  const actualTranscript = actualParts.join(" ");
  const referenceWords = normalizeWords(reference.referenceTranscript);
  const actualWords = normalizeWords(actualTranscript);
  const { edits, cost } = align(referenceWords, actualWords);
  const wordErrorRate = referenceWords.length === 0 ? 0 : cost / referenceWords.length;

  const technicalTerms = reference.technicalTerms.map((term) => {
    const normalized = normalizeWords(term).join(" ");
    const haystack = actualWords.join(" ");
    return { term, present: haystack.includes(normalized) };
  });
  const technicalTermAccuracy =
    technicalTerms.length === 0
      ? 0
      : technicalTerms.filter((entry) => entry.present).length / technicalTerms.length;

  const meaningChanges: string[] = [];
  for (const term of technicalTerms) {
    if (!term.present) {
      meaningChanges.push(`technical term missing from the transcript: ${term.term}`);
    }
  }
  const referenceNumbers = reference.referenceTranscript.match(/\b\d+\b/g) ?? [];
  const actualNumbers = actualTranscript.match(/\b\d+\b/g) ?? [];
  for (const number of referenceNumbers) {
    if (!actualNumbers.includes(number)) {
      meaningChanges.push(`numeric statement missing from the transcript: ${number}`);
    }
  }
  for (const number of actualNumbers) {
    if (!referenceNumbers.includes(number)) {
      meaningChanges.push(`numeric statement added by the transcript: ${number}`);
    }
  }
  if (
    /\bnot\b/.test(reference.referenceTranscript.toLowerCase()) &&
    !/\bnot\b/.test(actualTranscript.toLowerCase())
  ) {
    meaningChanges.push("negation present in the reference and absent from the transcript");
  }

  const finalizedTurns = canonicalFinals.length;
  return {
    referenceTranscript: reference.referenceTranscript,
    actualTranscript,
    referenceWords: referenceWords.length,
    wordErrorRate,
    edits,
    technicalTerms,
    technicalTermAccuracy,
    meaningChanges,
    turns,
    expectedTurns: reference.turns.length,
    finalizedTurns,
    missingFinals: Math.max(0, reference.turns.length - finalizedTurns),
    duplicatedFinals: Math.max(0, finalizedTurns - reference.turns.length),
    discontinuities: trace.filter((row) => row.kind === "canonical-discontinuity").length,
    latency: {
      firstPartial: summarize(
        turns
          .map((turn) => turn.firstPartialMs)
          .filter((value): value is number => value !== undefined),
      ),
      endOfSpeechToFinal: summarize(
        turns
          .map((turn) => turn.endOfSpeechToFinalMs)
          .filter((value): value is number => value !== undefined),
      ),
      providerEventToUi: summarize(
        turns
          .map((turn) => turn.providerEventToUiMs)
          .filter((value): value is number => value !== undefined),
      ),
      totalSourceToUi: summarize(
        turns
          .map((turn) => turn.totalSourceToUiMs)
          .filter((value): value is number => value !== undefined),
      ),
    },
  };
}

export function readTrace(path: string): TraceRow[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceRow);
}

export function formatReport(report: EvaluationReport): string {
  const lines: string[] = [];
  lines.push("Muse STT qualification report");
  lines.push("");
  lines.push(`reference: ${report.referenceTranscript}`);
  lines.push(`actual:   ${report.actualTranscript}`);
  lines.push("");
  lines.push(
    `word error rate: ${(report.wordErrorRate * 100).toFixed(2)}% ` +
      `(${report.edits.substitutions} substitutions, ${report.edits.deletions.length} deletions, ` +
      `${report.edits.insertions.length} insertions over ${report.referenceWords} reference words)`,
  );
  lines.push(`technical term accuracy: ${(report.technicalTermAccuracy * 100).toFixed(1)}%`);
  for (const term of report.technicalTerms) {
    lines.push(`  ${term.present ? "ok  " : "MISS"} ${term.term}`);
  }
  if (report.meaningChanges.length > 0) {
    lines.push("meaning changes:");
    for (const change of report.meaningChanges) lines.push(`  - ${change}`);
  }
  lines.push("");
  lines.push(
    `turns: expected ${report.expectedTurns}, finalized ${report.finalizedTurns}, ` +
      `missing ${report.missingFinals}, duplicated ${report.duplicatedFinals}, ` +
      `discontinuities ${report.discontinuities}`,
  );
  for (const turn of report.turns) {
    lines.push(
      `  ${turn.segmentId}: partials=${turn.partials} finalized=${turn.finalized} ` +
        `firstPartialMs=${turn.firstPartialMs ?? "n/a"} endToFinalMs=${turn.endOfSpeechToFinalMs ?? "n/a"} ` +
        `providerToUiMs=${turn.providerEventToUiMs ?? "n/a"} totalSourceToUiMs=${turn.totalSourceToUiMs ?? "n/a"}`,
    );
    if (turn.finalText.length > 0) lines.push(`    final: ${turn.finalText}`);
  }
  const latency = (name: string, summary: LatencySummary): void => {
    lines.push(
      `${name}: n=${summary.count} min=${summary.min ?? "n/a"} p50=${summary.p50 ?? "n/a"} ` +
        `p95=${summary.p95 ?? "n/a (sample too small)"} max=${summary.max ?? "n/a"}`,
    );
    if (summary.count > 0 && summary.count < 20) {
      lines.push(
        `  observations: ${summary.observations.map((value) => value.toFixed(1)).join(", ")}`,
      );
    }
  };
  lines.push("");
  latency("first partial latency (ms)", report.latency.firstPartial);
  latency("end of speech to final (ms)", report.latency.endOfSpeechToFinal);
  latency("provider event to observed render (ms)", report.latency.providerEventToUi);
  latency("total source to observed render (ms)", report.latency.totalSourceToUi);
  return lines.join("\n");
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("qualification/evaluate.ts");
if (invokedDirectly) {
  const tracePath = process.argv[2];
  if (tracePath === undefined) {
    process.stdout.write("usage: tsx lab/audio-slice/qualification/evaluate.ts <trace.jsonl>\n");
    process.exit(2);
  }
  const here = new URL(".", import.meta.url).pathname;
  const trace = readTrace(tracePath);
  const manifest = JSON.parse(readFileSync(`${here}audio/manifest.json`, "utf8")) as {
    spans: Record<string, ManifestSpan>;
  };
  const reference = JSON.parse(readFileSync(`${here}reference.json`, "utf8")) as ReferenceFixture;
  process.stdout.write(`${formatReport(evaluate(trace, manifest, reference))}\n`);
}
