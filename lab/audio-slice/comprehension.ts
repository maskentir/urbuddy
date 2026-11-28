import type { TranslationLanguages } from "../../src/modules/config/translation.js";
import type {
  TranslationEvent,
  TranslationProvider,
  TranslationSummary,
} from "../../src/modules/language/translation.js";
import { TranslationScheduler } from "../../src/modules/language/translation.js";
import type { TranscriptEvent } from "../../src/modules/perception/speech.js";
import { acceptedTranscript, type SessionOutput } from "../../src/modules/session/events.js";

import { applyTranslation, type DomainState } from "./projection.js";

export interface ComprehensionOptions {
  readonly provider: TranslationProvider;
  readonly languages: TranslationLanguages;
  readonly signal: AbortSignal;
  readonly domain: DomainState;
  readonly enableProvisionals?: boolean;
  readonly now?: () => number;
  readonly maxObservations?: number;
  readonly onPublished?: (event: TranslationEvent) => void;
}

export interface TranslationObservation {
  readonly type: "provisional" | "committed" | "invalidated" | "degraded";
  readonly utteranceId: string;
  readonly revision: number;
  readonly sourceArrivedMs: number | undefined;
  readonly queueMs: number | undefined;
  readonly responseMs: number | undefined;
  readonly publicationMs: number | undefined;
  readonly monoMs: number;
}

const DEFAULT_MAX_OBSERVATIONS = 256;

/**
 * [correctness] The comprehension engine owns the production translation
 * scheduler, so a translation request is always derived from a transcript
 * event the session runtime accepted, never from the scenario timeline and
 * never from a rejected, duplicate, or stale event.
 */
export class ComprehensionEngine {
  readonly observations: TranslationObservation[] = [];
  private readonly scheduler: TranslationScheduler;
  private readonly now: () => number;
  private readonly maxObservations: number;
  private readonly options: ComprehensionOptions;
  private readonly canonical = new Map<
    string,
    Extract<TranscriptEvent, { type: "partial" | "final" }>
  >();
  private consumed = 0;

  constructor(options: ComprehensionOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.maxObservations = options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
    this.scheduler = new TranslationScheduler({
      provider: options.provider,
      languages: options.languages,
      signal: options.signal,
      enableProvisionals: options.enableProvisionals ?? false,
      now: this.now,
      onEvent: async (event: TranslationEvent, isCurrent: () => boolean) => {
        if (!isCurrent()) {
          return false;
        }
        this.record({
          type: event.type,
          utteranceId: event.sourceUtteranceId,
          revision: event.sourceRevision,
          sourceArrivedMs:
            event.type === "committed" || event.type === "provisional"
              ? event.sourceArrivedMs
              : undefined,
          queueMs:
            event.type === "committed" || event.type === "provisional" ? event.queueMs : undefined,
          responseMs:
            event.type === "committed" || event.type === "provisional"
              ? event.responseMs
              : undefined,
          publicationMs:
            event.type === "committed" || event.type === "provisional"
              ? event.publicationMs
              : undefined,
          monoMs: this.now(),
        });
        applyTranslation(options.domain, event);
        options.onPublished?.(event);
        return true;
      },
    });
  }

  record(observation: TranslationObservation): void {
    this.observations.push(observation);
    if (this.observations.length > this.maxObservations) {
      this.observations.splice(0, this.observations.length - this.maxObservations);
    }
  }

  /**
   * [correctness] A canonical transcript event is only a candidate. It
   * becomes translation work when the session runtime accepted it.
   */
  ingest(event: TranscriptEvent): void {
    if (event.type === "discontinuity") {
      this.scheduler.consume(event);
      this.canonical.clear();
      return;
    }
    if (event.type === "partial" || event.type === "final") {
      this.canonical.set(event.utteranceId, event);
    }
  }

  accept(output: SessionOutput): void {
    if (output.type !== "applied") {
      return;
    }
    const candidate = this.canonical.get(output.utteranceId);
    if (candidate === undefined) {
      return;
    }
    this.canonical.delete(output.utteranceId);
    const source = acceptedTranscript(output, candidate);
    if (source === undefined) return;
    this.consumed += 1;
    const row = this.options.domain.byKey.get(output.utteranceId);
    if (row !== undefined && candidate.type === "final") {
      row.expectsTranslation = true;
    }
    this.scheduler.consume(source);
  }

  get acceptedEvents(): number {
    return this.consumed;
  }

  finish(): Promise<TranslationSummary> {
    return this.scheduler.finish();
  }
}
