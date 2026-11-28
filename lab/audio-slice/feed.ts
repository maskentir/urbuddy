import type { AppError } from "../../src/kernel/errors.js";
import { TranscriptReducer } from "../../src/modules/perception/speech.js";
import type { SpeechProviderEvent, TranscriptEvent } from "../../src/modules/perception/speech.js";
import type { SessionOutput, StreamEvent } from "../../src/modules/session/events.js";
import { SessionRuntime, type ReplaySource } from "../../src/modules/session/runtime.js";

import {
  TurnRegistry,
  type AuthoredTranscript,
  type GapSkip,
  type ProviderScheduleItem,
  type TranslationIntent,
} from "./adapter.js";
import {
  applyIntelligence,
  applySessionOutput,
  applyTranscriptDetail,
  applyTranslation,
  createDomain,
  recomputeEvidence,
  registerUtterance,
  type DomainState,
  type IntelligenceEvent,
} from "./projection.js";

export interface FeedOptions {
  readonly sessionId: string;
  readonly streamId: string;
  readonly provider: readonly ProviderScheduleItem[];
  readonly authoredTranscripts: readonly AuthoredTranscript[];
  readonly translations: readonly TranslationIntent[];
  readonly intelligence: readonly IntelligenceEvent[];
  readonly gapSkips: readonly GapSkip[];
  readonly signal?: AbortSignal;
  readonly onOutput?: (output: SessionOutput) => void;
}

class EventQueue implements ReplaySource {
  private items: StreamEvent[] = [];
  private waiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];
  private closed = false;
  inFlight = 0;

  push(event: StreamEvent): void {
    this.inFlight += 1;
    this.items.push(event);
    this.wake();
  }

  finish(): void {
    this.closed = true;
    this.wake();
  }

  abortPending(): void {
    this.items.length = 0;
    this.inFlight = 0;
    this.closed = true;
    this.wake();
  }

  settled(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    if (!this.quiescent()) return;
    const waiting = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resume of waiting) resume();
  }

  get events(): AsyncIterable<StreamEvent> {
    return this.iterate();
  }

  private async *iterate(): AsyncIterable<StreamEvent> {
    for (;;) {
      while (this.items.length === 0) {
        if (this.closed) return;
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
      }
      const next = this.items.shift();
      if (next !== undefined) yield next;
    }
  }

  async dispose(): Promise<void> {
    this.finish();
  }

  async idle(): Promise<void> {
    if (this.quiescent()) return;
    const settled = await new Promise<boolean>((resolve) => {
      this.idleWaiters.push(() => resolve(this.quiescent()));
      const timer = setTimeout(() => resolve(this.quiescent()), 2000);
      timer.unref();
    });
    if (!settled) throw new Error("runtime feed did not quiesce");
  }

  private quiescent(): boolean {
    return this.inFlight === 0 && this.items.length === 0;
  }

  private wake(): void {
    const waiting = this.waiters.splice(0, this.waiters.length);
    for (const resume of waiting) resume();
  }
}

export interface ReleasedMark {
  readonly providerIndex: number;
  readonly monoMs: number;
}

export interface AcceptedMark {
  readonly providerIndex: number;
  readonly utteranceId: string;
  readonly revision: number;
  readonly monoMs: number;
}

export interface AppliedMark {
  readonly utteranceId: string;
  readonly revision: number;
  readonly kind: string;
  readonly monoMs: number;
}

export interface ProjectedMark {
  readonly utteranceId: string;
  readonly revision: number;
  readonly kind: string;
  readonly monoMs: number;
}

export interface TranslationMark {
  readonly turnRef: string;
  readonly utteranceId: string | undefined;
  readonly applied: boolean;
  readonly monoMs: number;
}

export interface FeedInstrumentation {
  released: ReleasedMark[];
  accepted: AcceptedMark[];
  applied: AppliedMark[];
  projected: ProjectedMark[];
  translations: TranslationMark[];
}

export function summarizeLatency(values: number[]): {
  count: number;
  p50: number;
  p95: number;
  max: number;
} {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].toSorted((a, b) => a - b);
  const at = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return {
    count: sorted.length,
    p50: Math.round(at(0.5) * 100) / 100,
    p95: Math.round(at(0.95) * 100) / 100,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100,
  };
}

export interface AppliedBatch {
  readonly positionMs: number;
  readonly accepted: TranscriptEvent[];
  readonly authored: AuthoredTranscript[];
  readonly translations: TranslationIntent[];
  readonly intelligence: IntelligenceEvent[];
}

function utteranceKey(event: TranscriptEvent): string {
  if (event.type === "partial" || event.type === "final") return event.utteranceId;
  return "";
}

function revisionOf(event: TranscriptEvent): number {
  if (event.type === "partial" || event.type === "final") return event.revision;
  return -1;
}

export class RuntimeFeed {
  readonly domain: DomainState = createDomain();
  readonly registry = new TurnRegistry();
  readonly instrumentation: FeedInstrumentation = {
    released: [],
    accepted: [],
    applied: [],
    projected: [],
    translations: [],
  };
  fatal?: AppError;
  private cursor = 0;
  private authoredCursor = 0;
  private translationCursor = 0;
  private intelligenceCursor = 0;
  private skipCursor = 0;
  private nextSeq = 0;
  private readonly queue = new EventQueue();
  private readonly reducer = new TranscriptReducer();
  private readonly runtime = new SessionRuntime();
  private runPromise?: Promise<void>;
  private finished = false;

  constructor(private readonly options: FeedOptions) {}

  start(): void {
    const signal = this.options.signal;
    this.runPromise = (async () => {
      const outcome = await this.runtime.run(
        this.queue,
        async (output) => {
          this.applyOutput(output);
          this.options.onOutput?.(output);
        },
        signal === undefined ? {} : { signal },
      );
      if (outcome.isErr()) {
        this.fatal = outcome.error;
      }
    })();
  }

  releaseDue(positionMs: number): AppliedBatch {
    const accepted: TranscriptEvent[] = [];
    const freshAuthored: AuthoredTranscript[] = [];
    const freshTranslations: TranslationIntent[] = [];
    const freshIntelligence: IntelligenceEvent[] = [];
    if (this.options.signal?.aborted === true) {
      return {
        positionMs,
        accepted,
        authored: freshAuthored,
        translations: freshTranslations,
        intelligence: freshIntelligence,
      };
    }
    const schedule = this.options.provider;
    while (this.cursor < schedule.length) {
      const next = schedule[this.cursor];
      if (next === undefined || next.atMs > positionMs) break;
      this.cursor += 1;
      const providerIndex = this.cursor - 1;
      this.instrumentation.released.push({ providerIndex, monoMs: performance.now() });
      const applied = this.reducer.apply(next.event);
      if (applied.isErr()) {
        this.domain.rejected.push({ kind: "provider", reason: applied.error.message });
        continue;
      }
      if (applied.value === undefined) continue;
      this.instrumentation.accepted.push({
        providerIndex,
        utteranceId: utteranceKey(applied.value),
        revision: revisionOf(applied.value),
        monoMs: performance.now(),
      });
      accepted.push(applied.value);
      this.acceptTranscript(applied.value, next.event, next.atMs);
      for (const queued of this.reducer.drainPending()) {
        this.instrumentation.accepted.push({
          providerIndex,
          utteranceId: utteranceKey(queued),
          revision: revisionOf(queued),
          monoMs: performance.now(),
        });
        accepted.push(queued);
        this.acceptTranscript(queued, next.event, next.atMs);
      }
    }
    const gapSkips = this.options.gapSkips;
    while (this.skipCursor < gapSkips.length) {
      const gap = gapSkips[this.skipCursor];
      if (gap === undefined || gap.atMs > positionMs) break;
      this.skipCursor += 1;
      this.nextSeq += gap.skip;
    }
    const authored = this.options.authoredTranscripts;
    while (this.authoredCursor < authored.length) {
      const next = authored[this.authoredCursor];
      if (next === undefined || next.atMs > positionMs) break;
      this.authoredCursor += 1;
      applyTranscriptDetail(this.domain, next.event);
      freshAuthored.push(next);
    }
    const translations = this.options.translations;
    while (this.translationCursor < translations.length) {
      const next = translations[this.translationCursor];
      if (next === undefined || next.atMs > positionMs) break;
      this.translationCursor += 1;
      this.fireTranslation(next);
      freshTranslations.push(next);
    }
    const intelligence = this.options.intelligence;
    while (this.intelligenceCursor < intelligence.length) {
      const next = intelligence[this.intelligenceCursor];
      if (next === undefined || next.atMs > positionMs) break;
      this.intelligenceCursor += 1;
      applyIntelligence(this.domain, next, (turnRef) => this.registry.resolveTurnRef(turnRef));
      freshIntelligence.push(next);
    }
    this.recomputeResolutions();
    return {
      positionMs,
      accepted,
      authored: freshAuthored,
      translations: freshTranslations,
      intelligence: freshIntelligence,
    };
  }

  async idle(): Promise<void> {
    await this.queue.idle();
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.queue.finish();
  }

  abort(): void {
    this.queue.abortPending();
  }

  async completion(): Promise<void> {
    await this.runPromise;
  }

  latencySummary(): {
    releaseAcceptMs: { count: number; p50: number; p95: number; max: number };
    acceptApplyMs: { count: number; p50: number; p95: number; max: number };
    applyProjectMs: { count: number; p50: number; p95: number; max: number };
    translations: { arrived: number; applied: number; rejected: number };
  } {
    const releasedByProvider = new Map<number, number>();
    for (const mark of this.instrumentation.released) {
      releasedByProvider.set(mark.providerIndex, mark.monoMs);
    }
    const releaseAccept: number[] = [];
    for (const mark of this.instrumentation.accepted) {
      const releasedAt = releasedByProvider.get(mark.providerIndex);
      if (releasedAt !== undefined) releaseAccept.push(mark.monoMs - releasedAt);
    }
    const acceptedByKey = new Map<string, number>();
    for (const mark of this.instrumentation.accepted) {
      acceptedByKey.set(`${mark.utteranceId}:${mark.revision}`, mark.monoMs);
    }
    const acceptApply: number[] = [];
    for (const mark of this.instrumentation.applied) {
      const acceptedAt = acceptedByKey.get(`${mark.utteranceId}:${mark.revision}`);
      if (acceptedAt !== undefined) acceptApply.push(mark.monoMs - acceptedAt);
    }
    const appliedByKey = new Map<string, number>();
    for (const mark of this.instrumentation.applied) {
      appliedByKey.set(`${mark.utteranceId}:${mark.revision}`, mark.monoMs);
    }
    const applyProject: number[] = [];
    for (const mark of this.instrumentation.projected) {
      const appliedAt = appliedByKey.get(`${mark.utteranceId}:${mark.revision}`);
      if (appliedAt !== undefined) applyProject.push(mark.monoMs - appliedAt);
    }
    return {
      releaseAcceptMs: summarizeLatency(releaseAccept),
      acceptApplyMs: summarizeLatency(acceptApply),
      applyProjectMs: summarizeLatency(applyProject),
      translations: {
        arrived: this.instrumentation.translations.length,
        applied: this.instrumentation.translations.filter((mark) => mark.applied).length,
        rejected: this.instrumentation.translations.filter((mark) => !mark.applied).length,
      },
    };
  }

  injectStreamEvent(event: StreamEvent): void {
    this.queue.push(event);
  }

  private acceptTranscript(
    event: TranscriptEvent,
    source: SpeechProviderEvent,
    atMs: number,
  ): void {
    this.registry.observeAccepted(event, source);
    if (event.type !== "partial" && event.type !== "final") return;
    const turnRef = this.registry.turnRefFor(event.utteranceId);
    if (turnRef !== undefined && !this.domain.byKey.has(event.utteranceId)) {
      registerUtterance(this.domain, event.utteranceId, turnRef, event.speaker ?? "", atMs);
    } else if (turnRef !== undefined) {
      const row = this.domain.byKey.get(event.utteranceId);
      if (row !== undefined && row.speakerKey === "" && event.speaker !== undefined) {
        row.speakerKey = event.speaker;
      }
    }
    const stream: StreamEvent = {
      sessionId: this.options.sessionId,
      streamId: this.options.streamId,
      seq: this.nextSeq,
      utteranceId: event.utteranceId,
      revision: event.revision,
      kind: event.type,
      text: event.text,
    };
    this.nextSeq += 1;
    this.queue.push(stream);
  }

  private fireTranslation(intent: TranslationIntent): void {
    const utteranceId = this.registry.resolveTurnRef(intent.turnRef);
    const target = utteranceId === undefined ? undefined : this.domain.byKey.get(utteranceId);
    if (utteranceId === undefined || target === undefined) {
      this.domain.translationsRejected += 1;
      this.domain.rejected.push({ kind: "translation", reason: `unknown turn ${intent.turnRef}` });
      this.instrumentation.translations.push({
        turnRef: intent.turnRef,
        utteranceId,
        applied: false,
        monoMs: performance.now(),
      });
      return;
    }
    const sourceRevision = intent.sourceRevision ?? target.revision;
    const committed = {
      type: "committed",
      operationId: "audio-slice-replay",
      unitId: `authored-${intent.turnRef}`,
      sourceUtteranceId: utteranceId,
      sourceRevision,
      sourceLanguage: "auto",
      targetLanguage: "id",
      providerId: "authored-replay",
      modelId: "authored",
      promptVersion: "n/a",
      context: [],
      coverageUncertain: false,
      text: intent.text,
      fragment: false,
      sourceArrivedMs: 0,
      queueMs: 0,
      responseMs: 0,
      publicationMs: 0,
    } as const;
    applyTranslation(this.domain, committed);
    this.instrumentation.translations.push({
      turnRef: intent.turnRef,
      utteranceId,
      applied: true,
      monoMs: performance.now(),
    });
  }

  private applyOutput(output: SessionOutput): void {
    if (output.type === "applied") {
      this.instrumentation.applied.push({
        utteranceId: output.utteranceId,
        revision: output.revision,
        kind: output.kind,
        monoMs: performance.now(),
      });
    } else if (output.type === "stale" || output.type === "duplicate") {
      this.instrumentation.applied.push({
        utteranceId: output.utteranceId,
        revision: output.revision,
        kind: output.type,
        monoMs: performance.now(),
      });
    }
    applySessionOutput(this.domain, output);
    if (output.type === "applied" || output.type === "duplicate" || output.type === "stale") {
      this.instrumentation.projected.push({
        utteranceId: output.utteranceId,
        revision: output.revision,
        kind: output.type,
        monoMs: performance.now(),
      });
    }
    this.queue.settled();
    this.recomputeResolutions();
  }

  private recomputeResolutions(): void {
    recomputeEvidence(this.domain, (turnRef: string) => this.registry.resolveTurnRef(turnRef));
  }
}
