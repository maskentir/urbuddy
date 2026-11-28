import type { TranslationLanguages } from "../../src/modules/config/translation.js";
import type {
  TranslationEvent,
  TranslationProvider,
  TranslationSummary,
} from "../../src/modules/language/translation.js";
import { TranslationScheduler } from "../../src/modules/language/translation.js";
import type { TranscriptEvent } from "../../src/modules/perception/speech.js";

import { applyTranslation, type DomainState } from "./projection.js";

export interface ComprehensionOptions {
  readonly provider: TranslationProvider;
  readonly languages: TranslationLanguages;
  readonly signal: AbortSignal;
  readonly domain: DomainState;
  readonly enableProvisionals?: boolean;
  readonly now?: () => number;
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

/**
 * [correctness] The comprehension engine owns the production translation
 * scheduler, so a translation request is always derived from an accepted
 * transcript event and never from the scenario timeline.
 */
export class ComprehensionEngine {
  readonly observations: TranslationObservation[] = [];
  private readonly scheduler: TranslationScheduler;
  private readonly now: () => number;
  private readonly domain: DomainState;

  constructor(options: ComprehensionOptions) {
    this.domain = options.domain;
    this.now = options.now ?? (() => performance.now());
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
        this.observations.push({
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
        return true;
      },
    });
  }

  consume(event: TranscriptEvent): void {
    if (event.type === "final") {
      const row = this.domain.byKey.get(event.utteranceId);
      if (row !== undefined) row.expectsTranslation = true;
    }
    this.scheduler.consume(event);
  }

  finish(): Promise<TranslationSummary> {
    return this.scheduler.finish();
  }
}
