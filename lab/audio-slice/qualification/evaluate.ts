import { readFileSync } from "node:fs";

import {
  alignWords,
  normalizeWords,
  NORMALIZATION_POLICY_VERSION,
  type Alignment,
  type WordEdits,
} from "./word-alignment.js";

export interface TraceRow {
  readonly kind: string;
  readonly monoMs: number;
  readonly elapsedMs: number;
  readonly detail: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface ManifestSpan {
  readonly startMs: number;
  readonly durationMs: number;
}

export interface ReferenceFixture {
  readonly fixtureId: string;
  readonly technicalTerms: readonly string[];
  readonly turns: readonly { readonly id: string; readonly text: string }[];
  readonly referenceTranscript: string;
}

export interface LatencySummary {
  readonly count: number;
  readonly min: number | undefined;
  readonly p50: number | undefined;
  readonly p95: number | undefined;
  readonly max: number | undefined;
  readonly observations: readonly number[];
}

export interface SegmentAlignment {
  readonly segmentId: string;
  readonly referenceText: string;
  readonly providerTurns: readonly string[];
  readonly status: "aligned" | "split" | "missing";
}

export interface ProviderTurnAlignment {
  readonly turn: string;
  readonly referenceSegments: readonly string[];
  readonly finalText: string;
  readonly status: "aligned" | "merged" | "inserted" | "split";
  readonly firstPartialMs: number | undefined;
  readonly endOfSpeechToFinalMs: number | undefined;
  readonly providerEventToRenderMs: number | undefined;
  readonly totalSourceToUiMs: number | undefined;
  readonly notes: readonly string[];
}

export interface IntegrityGates {
  readonly completeAudioTransmission: boolean | undefined;
  readonly providerEndAcknowledged: boolean;
  readonly unexpectedDiscontinuities: number;
  readonly staleCanonicalState: number;
  readonly duplicateCanonicalState: number;
  readonly turnAlignmentResolved: boolean;
  readonly referenceInjectedIntoRuntime: false;
  readonly transcriptCorrectionApplied: false;
  readonly cleanShutdown: boolean;
}

export interface EvaluationReport {
  readonly normalizationPolicy: string;
  readonly referenceWords: number;
  readonly hypothesisWords: number;
  readonly wordErrorRate: number;
  readonly edits: WordEdits;
  readonly technicalTerms: readonly { readonly term: string; readonly present: boolean }[];
  readonly technicalTermAccuracy: number;
  readonly meaningChanges: readonly string[];
  readonly segmentAlignment: readonly SegmentAlignment[];
  readonly providerTurns: readonly ProviderTurnAlignment[];
  readonly missingSegments: readonly string[];
  readonly insertedTurns: readonly string[];
  readonly ambiguous: readonly string[];
  readonly latency: {
    readonly firstPartial: LatencySummary;
    readonly endOfSpeechToFinal: LatencySummary;
    readonly providerEventToRender: LatencySummary;
    readonly totalSourceToUi: LatencySummary;
    readonly coldStart: LatencySummary;
  };
  readonly integrity: IntegrityGates;
  readonly unavailable: readonly string[];
}

interface WordRange {
  readonly id: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function ranges(items: readonly { readonly id: string; readonly text: string }[]): {
  readonly ranges: WordRange[];
  readonly words: string[];
} {
  const words: string[] = [];
  const built: WordRange[] = [];
  for (const item of items) {
    const normalized = normalizeWords(item.text);
    const start = words.length;
    words.push(...normalized);
    built.push({ id: item.id, text: item.text, start, end: words.length });
  }
  return { ranges: built, words };
}

function contiguous(ids: readonly string[], order: readonly string[]): boolean {
  const positions = ids
    .map((id) => order.indexOf(id))
    .filter((position) => position >= 0)
    .toSorted((left, right) => left - right);
  if (positions.length <= 1) return true;
  for (let index = 1; index < positions.length; index += 1) {
    if ((positions[index] ?? 0) !== (positions[index - 1] ?? 0) + 1) return false;
  }
  return true;
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

function numberAt(row: TraceRow | undefined, key: string): number | undefined {
  const value = row?.data?.[key];
  return typeof value === "number" ? value : undefined;
}

function stringAt(row: TraceRow | undefined, key: string): string | undefined {
  const value = row?.data?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * [correctness] Reads the turn and the text of a provider event. The
 * structured fields are preferred and the detail fallback exists for traces
 * recorded before the structured rows existed.
 */
function turnOf(row: TraceRow | undefined): string | undefined {
  return stringAt(row, "turn") ?? row?.detail.match(/turn=([^ ]+)/)?.[1];
}

function textOf(row: TraceRow | undefined): string {
  const structured = stringAt(row, "text");
  if (structured !== undefined) return structured;
  const marker = row?.detail.indexOf("text=");
  return marker === undefined ? "" : (row?.detail.slice(marker + 5) ?? "");
}

/**
 * [correctness] Maps a source audio position to the monotonic time at which
 * that audio was handed to the provider, so the audio origin is the
 * transmission and never the process start.
 */
function transmissionClock(
  sends: readonly TraceRow[],
  sampleRate: number,
): (sourcePositionMs: number) => number | undefined {
  const frames: number[] = [];
  const times: number[] = [];
  for (const send of sends) {
    const cumulative = numberAt(send, "cumulativeFrames");
    if (cumulative === undefined) continue;
    frames.push(cumulative);
    times.push(send.monoMs);
  }
  return (sourcePositionMs: number): number | undefined => {
    const target = Math.round((sourcePositionMs / 1000) * sampleRate);
    let chosen: number | undefined;
    for (let index = 0; index < frames.length; index += 1) {
      const cumulative = frames[index] ?? 0;
      if (cumulative >= target) {
        chosen = times[index];
        break;
      }
    }
    return chosen;
  };
}

export function evaluate(
  trace: readonly TraceRow[],
  manifest: { readonly spans: Record<string, ManifestSpan>; readonly sampleRate?: number },
  reference: ReferenceFixture,
): EvaluationReport {
  const unavailable: string[] = [];
  const sampleRate = manifest.sampleRate ?? 16_000;
  const referenceBuild = ranges(reference.turns);
  const committedFinals = trace.filter((row) => row.kind === "final-committed");
  const legacyFinals = trace.filter(
    (row) =>
      row.kind === "final-received" ||
      (row.kind === "provider-event" && row.detail.startsWith("completed")),
  );
  const finals = committedFinals.length > 0 ? committedFinals : legacyFinals;
  const providerBuild = ranges(
    finals.map((row, index) => ({
      id: turnOf(row) ?? stringAt(row, "utteranceId") ?? `turn-${index + 1}`,
      text: textOf(row),
    })),
  );
  const alignment: Alignment = alignWords(referenceBuild.words, providerBuild.words);
  const edits = alignment.edits;
  const wordErrorRate =
    referenceBuild.words.length === 0 ? 0 : edits.editDistance / referenceBuild.words.length;

  const segmentToTurns = new Map<string, Set<string>>();
  const turnToSegments = new Map<string, Set<string>>();
  const segmentTurns = (segmentId: string): Set<string> => {
    const existing = segmentToTurns.get(segmentId);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    segmentToTurns.set(segmentId, created);
    return created;
  };
  const turnSegments = (turnId: string): Set<string> => {
    const existing = turnToSegments.get(turnId);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    turnToSegments.set(turnId, created);
    return created;
  };
  for (const pair of alignment.pairs) {
    const segment = referenceBuild.ranges.find(
      (range) => pair.referenceIndex >= range.start && pair.referenceIndex < range.end,
    );
    const turn = providerBuild.ranges.find(
      (range) => pair.hypothesisIndex >= range.start && pair.hypothesisIndex < range.end,
    );
    if (segment === undefined || turn === undefined) continue;
    segmentTurns(segment.id).add(turn.id);
    turnSegments(turn.id).add(segment.id);
  }

  const segmentIds: string[] = referenceBuild.ranges.map((range) => range.id);
  const turnIds: string[] = providerBuild.ranges.map((range) => range.id);
  const ambiguous: string[] = [];
  const segmentAlignment: SegmentAlignment[] = referenceBuild.ranges.map((range) => {
    const turns = [...segmentTurns(range.id)].toSorted(
      (a, b) => turnIds.indexOf(a) - turnIds.indexOf(b),
    );
    if (turns.length === 0) {
      return {
        segmentId: range.id,
        referenceText: range.text,
        providerTurns: [],
        status: "missing",
      };
    }
    if (!contiguous(turns, turnIds)) {
      ambiguous.push(`segment ${range.id} maps to non contiguous turns ${turns.join(",")}`);
      return {
        segmentId: range.id,
        referenceText: range.text,
        providerTurns: turns,
        status: "split",
      };
    }
    return {
      segmentId: range.id,
      referenceText: range.text,
      providerTurns: turns,
      status: turns.length === 1 ? "aligned" : "split",
    };
  });

  const partialsByTurn = new Map<string, TraceRow[]>();
  for (const row of trace.filter(
    (item) => item.kind === "partial-committed" || item.kind === "partial-received",
  )) {
    const turn = turnOf(row) ?? stringAt(row, "utteranceId") ?? "";
    const bucket = partialsByTurn.get(turn) ?? [];
    bucket.push(row);
    partialsByTurn.set(turn, bucket);
  }
  const rendersByUtterance = new Map<string, TraceRow>();
  for (const row of trace.filter((item) => item.kind === "render-completed")) {
    if (row.data?.["confirmed"] !== true) continue;
    const key = `${stringAt(row, "utteranceId") ?? ""}:${numberAt(row, "revision") ?? 0}`;
    const existing = rendersByUtterance.get(key);
    if (existing === undefined || row.monoMs < existing.monoMs) {
      rendersByUtterance.set(key, row);
    }
  }
  const sends = trace.filter((row) => row.kind === "audio-sent");
  const transmittedAt = transmissionClock(sends, sampleRate);

  const providerTurns: ProviderTurnAlignment[] = providerBuild.ranges.map((range) => {
    const notes: string[] = [];
    const segments = [...turnSegments(range.id)].toSorted(
      (a, b) => segmentIds.indexOf(a) - segmentIds.indexOf(b),
    );
    const splitSegment = segments.length === 1 && segmentTurns(segments[0] ?? "").size > 1;
    const status: ProviderTurnAlignment["status"] =
      segments.length === 0
        ? "inserted"
        : splitSegment
          ? "split"
          : segments.length === 1
            ? "aligned"
            : "merged";
    if (status === "merged") {
      notes.push(`one provider turn covers ${segments.length} reference segments`);
    }
    if (status === "inserted") {
      notes.push("provider turn has no aligned reference segment");
    }
    const firstSegment = referenceBuild.ranges.find((range) => range.id === segments[0]);
    const lastSegment = [...referenceBuild.ranges]
      .reverse()
      .find((range) => range.id === segments[segments.length - 1]);
    const firstSegmentSpan =
      firstSegment === undefined ? undefined : manifest.spans[firstSegment.id];
    const lastSegmentSpan = lastSegment === undefined ? undefined : manifest.spans[lastSegment.id];
    const partials = partialsByTurn.get(range.id) ?? [];
    const firstPartial = partials[0];
    const finalRow = finals.find(
      (row) => (turnOf(row) ?? stringAt(row, "utteranceId") ?? "") === range.id,
    );
    const finalReceiptMs =
      finalRow === undefined
        ? undefined
        : (numberAt(finalRow, "providerMonoMs") ?? finalRow.monoMs);

    let firstPartialMs: number | undefined;
    let endOfSpeechToFinalMs: number | undefined;
    let totalSourceToUiMs: number | undefined;
    if (status === "split") {
      unavailable.push(`latency for turn ${range.id} is unavailable because its segment was split`);
    } else if (firstSegment !== undefined && firstPartial !== undefined) {
      const onset =
        firstSegmentSpan === undefined ? undefined : transmittedAt(firstSegmentSpan.startMs);
      const partialReceiptMs = numberAt(firstPartial, "providerMonoMs") ?? firstPartial.monoMs;
      if (onset === undefined) {
        unavailable.push(`transmission time for the onset of ${firstSegment.id} is unavailable`);
      } else {
        firstPartialMs = partialReceiptMs - onset;
      }
    }
    if (status !== "split" && lastSegment !== undefined && finalRow !== undefined) {
      const end =
        lastSegmentSpan === undefined
          ? undefined
          : transmittedAt(lastSegmentSpan.startMs + lastSegmentSpan.durationMs);
      if (end === undefined) {
        unavailable.push(`transmission time for the end of ${lastSegment.id} is unavailable`);
      } else if (finalReceiptMs !== undefined) {
        endOfSpeechToFinalMs = finalReceiptMs - end;
      }
    }

    const utteranceId = stringAt(finalRow, "utteranceId");
    const revision = numberAt(finalRow, "revision");
    let providerEventToRenderMs: number | undefined;
    if (utteranceId !== undefined && revision !== undefined) {
      const render = rendersByUtterance.get(`${utteranceId}:${revision}`);
      if (render === undefined) {
        unavailable.push(`no confirmed render for ${utteranceId} revision ${revision}`);
      } else if (finalReceiptMs !== undefined) {
        providerEventToRenderMs = render.monoMs - finalReceiptMs;
      }
    }
    if (utteranceId !== undefined && revision !== undefined && firstSegment !== undefined) {
      const onset =
        firstSegmentSpan === undefined ? undefined : transmittedAt(firstSegmentSpan.startMs);
      const render = rendersByUtterance.get(`${utteranceId}:${revision}`);
      if (onset !== undefined && render !== undefined && render.data?.["confirmed"] === true) {
        totalSourceToUiMs = render.monoMs - onset;
      }
    }
    return {
      turn: range.id,
      referenceSegments: segments,
      finalText: range.text,
      status,
      firstPartialMs,
      endOfSpeechToFinalMs,
      providerEventToRenderMs,
      totalSourceToUiMs,
      notes,
    };
  });

  const missingSegments = segmentAlignment
    .filter((entry) => entry.status === "missing")
    .map((entry) => entry.segmentId);
  const insertedTurns = providerTurns
    .filter((entry) => entry.status === "inserted")
    .map((entry) => entry.turn);

  const technicalTerms = reference.technicalTerms.map((term) => {
    const normalized = normalizeWords(term).join(" ");
    const haystack = providerBuild.words.join(" ");
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
  const referenceNumbers: string[] = reference.referenceTranscript.match(/\b\d+\b/g) ?? [];
  const actualNumbers: string[] =
    providerBuild.ranges
      .map((range) => range.text)
      .join(" ")
      .match(/\b\d+\b/g) ?? [];
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
    !/\bnot\b/.test(
      providerBuild.ranges
        .map((range) => range.text)
        .join(" ")
        .toLowerCase(),
    )
  ) {
    meaningChanges.push("negation present in the reference and absent from the transcript");
  }
  for (const substitution of edits.substitutions) {
    meaningChanges.push(
      `substitution: "${substitution.reference}" became "${substitution.hypothesis}"`,
    );
  }

  const sessionInitiation = trace.find((row) => row.kind === "session-initiation");
  const firstPartialAny = trace.find((row) => row.kind === "partial-received");
  const coldStart =
    sessionInitiation !== undefined && firstPartialAny !== undefined
      ? [firstPartialAny.monoMs - sessionInitiation.monoMs]
      : [];

  const shutdown = trace.find((row) => row.kind === "shutdown");
  const summary = trace.find((row) => row.kind === "provider-summary");
  const sourceFrames = numberAt(shutdown, "sourceFrames");
  const transmittedFrames = numberAt(shutdown, "transmittedFrames");
  const integrity: IntegrityGates = {
    completeAudioTransmission:
      sourceFrames === undefined || transmittedFrames === undefined
        ? undefined
        : sourceFrames === transmittedFrames,
    providerEndAcknowledged: summary !== undefined,
    unexpectedDiscontinuities: numberAt(shutdown, "discontinuities") ?? 0,
    staleCanonicalState: numberAt(shutdown, "stale") ?? 0,
    duplicateCanonicalState: numberAt(shutdown, "duplicates") ?? 0,
    turnAlignmentResolved: ambiguous.length === 0,
    referenceInjectedIntoRuntime: false,
    transcriptCorrectionApplied: false,
    cleanShutdown: shutdown !== undefined && numberAt(shutdown, "code") === 0,
  };

  return {
    normalizationPolicy: NORMALIZATION_POLICY_VERSION,
    referenceWords: referenceBuild.words.length,
    hypothesisWords: providerBuild.words.length,
    wordErrorRate,
    edits,
    technicalTerms,
    technicalTermAccuracy,
    meaningChanges,
    segmentAlignment,
    providerTurns,
    missingSegments,
    insertedTurns,
    ambiguous,
    latency: {
      firstPartial: summarize(
        providerTurns
          .map((turn) => turn.firstPartialMs)
          .filter((value): value is number => value !== undefined),
      ),
      endOfSpeechToFinal: summarize(
        providerTurns
          .map((turn) => turn.endOfSpeechToFinalMs)
          .filter((value): value is number => value !== undefined),
      ),
      providerEventToRender: summarize(
        providerTurns
          .map((turn) => turn.providerEventToRenderMs)
          .filter((value): value is number => value !== undefined),
      ),
      totalSourceToUi: summarize(
        providerTurns
          .map((turn) => turn.totalSourceToUiMs)
          .filter((value): value is number => value !== undefined),
      ),
      coldStart: summarize(coldStart),
    },
    integrity,
    unavailable,
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
  lines.push(`normalization policy: ${report.normalizationPolicy}`);
  lines.push("");
  lines.push(
    `word error rate: ${(report.wordErrorRate * 100).toFixed(3)}% ` +
      `(${report.edits.substitutions.length} substitutions, ${report.edits.deletions.length} deletions, ` +
      `${report.edits.insertions.length} insertions, edit distance ${report.edits.editDistance} over ` +
      `${report.referenceWords} reference words)`,
  );
  for (const substitution of report.edits.substitutions) {
    lines.push(`  substitution: "${substitution.reference}" -> "${substitution.hypothesis}"`);
  }
  for (const deletion of report.edits.deletions) lines.push(`  deletion: "${deletion}"`);
  for (const insertion of report.edits.insertions) lines.push(`  insertion: "${insertion}"`);
  lines.push("");
  lines.push(`technical term accuracy: ${(report.technicalTermAccuracy * 100).toFixed(1)}%`);
  for (const term of report.technicalTerms) {
    lines.push(`  ${term.present ? "ok  " : "MISS"} ${term.term}`);
  }
  if (report.meaningChanges.length > 0) {
    lines.push("meaning changes:");
    for (const change of report.meaningChanges) lines.push(`  - ${change}`);
  }
  lines.push("");
  lines.push("segment alignment:");
  for (const segment of report.segmentAlignment) {
    lines.push(
      `  ${segment.segmentId}: ${segment.status} -> turns [${segment.providerTurns.join(", ")}]`,
    );
  }
  lines.push("provider turns:");
  for (const turn of report.providerTurns) {
    lines.push(
      `  ${turn.turn}: ${turn.status} segments [${turn.referenceSegments.join(", ")}] ` +
        `firstPartialMs=${turn.firstPartialMs ?? "unavailable"} ` +
        `endToFinalMs=${turn.endOfSpeechToFinalMs ?? "unavailable"} ` +
        `providerToRenderMs=${turn.providerEventToRenderMs ?? "unavailable"} ` +
        `totalSourceToUiMs=${turn.totalSourceToUiMs ?? "unavailable"}`,
    );
    for (const note of turn.notes) lines.push(`    note: ${note}`);
    if (turn.finalText.length > 0) lines.push(`    final: ${turn.finalText}`);
  }
  if (report.missingSegments.length > 0) {
    lines.push(`missing reference segments: ${report.missingSegments.join(", ")}`);
  }
  if (report.insertedTurns.length > 0) {
    lines.push(`inserted provider turns: ${report.insertedTurns.join(", ")}`);
  }
  if (report.ambiguous.length > 0) {
    lines.push("ambiguous alignment:");
    for (const entry of report.ambiguous) lines.push(`  - ${entry}`);
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
  latency("cold start, session initiation to first partial (ms)", report.latency.coldStart);
  latency("streaming first partial after the transmitted onset (ms)", report.latency.firstPartial);
  latency("end of transmitted speech to final (ms)", report.latency.endOfSpeechToFinal);
  latency("provider event to confirmed render (ms)", report.latency.providerEventToRender);
  latency("total transmitted source to confirmed render (ms)", report.latency.totalSourceToUi);
  lines.push("");
  lines.push("integrity gates:");
  const gates = report.integrity;
  lines.push(`  complete audio transmission: ${gates.completeAudioTransmission ?? "unavailable"}`);
  lines.push(`  provider end acknowledged: ${gates.providerEndAcknowledged}`);
  lines.push(`  unexpected discontinuities: ${gates.unexpectedDiscontinuities}`);
  lines.push(`  stale canonical state: ${gates.staleCanonicalState}`);
  lines.push(`  duplicate canonical state: ${gates.duplicateCanonicalState}`);
  lines.push(`  turn alignment resolved: ${gates.turnAlignmentResolved}`);
  lines.push(`  reference injected into runtime: ${gates.referenceInjectedIntoRuntime}`);
  lines.push(`  transcript correction applied: ${gates.transcriptCorrectionApplied}`);
  lines.push(`  clean shutdown: ${gates.cleanShutdown}`);
  if (report.unavailable.length > 0) {
    lines.push("unavailable measurements:");
    for (const entry of report.unavailable) lines.push(`  - ${entry}`);
  }
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
    sampleRate: number;
    spans: Record<string, ManifestSpan>;
  };
  const reference = JSON.parse(readFileSync(`${here}reference.json`, "utf8")) as ReferenceFixture;
  process.stdout.write(`${formatReport(evaluate(trace, manifest, reference))}\n`);
}
