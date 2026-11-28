# Contextual comprehension capability inventory

Date: 2026-11-28. Branch: `feat/contextual-comprehension`, stacked on
`feat/muse-stt-qualification`.

## Existing capabilities

| Area                                                                 | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `src/modules/language/translation.ts`                                | Implemented and tested. `TranslationScheduler` consumes canonical transcript events, keeps occurrence identity and revision, bounds the context to five utterances, bounds pending committed work to sixteen, debounces 400 ms, drains within 10 s, and publishes `provisional`, `committed`, `invalidated`, and `degraded` events. The `TranslationSummary` already carries requests, responses, failures, cancellations, stale rejections, degraded counts, uncovered sources, and token usage. | `tests/translation-openai.test.ts`, the repo gate |
| `src/adapters/translation/openai.ts`                                 | Implemented. The existing LangChain `ChatOpenAI` adapter, JSON object response format, reasoning effort `none`, at most 1,024 completion tokens, zero retries, an 8 s request timeout, and a loopback-only test endpoint.                                                                                                                                                                                                                                                                         | same                                              |
| `src/modules/config/translation.ts`                                  | Implemented. Language canonicalisation, explicit provider selection, and the model identifier.                                                                                                                                                                                                                                                                                                                                                                                                    | `tests/config.test.ts`                            |
| `src/modules/session/runtime.ts`                                     | Implemented. Sequence, duplicate, stale, gap, and cancellation rules for canonical stream events.                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/session.replay.test.ts`                    |
| `evaluation/language/prompts/urbuddy-translation-v3.json`            | Frozen prompt artifact. The same text is embedded in the scheduler, so the two copies can drift.                                                                                                                                                                                                                                                                                                                                                                                                  | `evaluation/language/model-selection.md`          |
| `tooling/evaluate-translation.mjs`                                   | Implemented. Replays a frozen corpus against the pinned endpoint with blind semantic review.                                                                                                                                                                                                                                                                                                                                                                                                      | `evaluation/language/results`                     |
| Indonesian glossary                                                  | Implemented inside the scheduler as `INDONESIAN_GLOSSARY`, applied only when the target language is Indonesian and reported as `glossaryId: technical-id-v1`. It is a domain glossary, not an answer key.                                                                                                                                                                                                                                                                                         | `src/modules/language/translation.ts`             |
| Semantic policy                                                      | Implemented in the prompt. It already requires preserving speaker relationships, negation, tense, modality, conditions, exceptions, exact time boundaries, quantities, units, identifiers, ambiguity, unfinished thoughts, code switching, and corrections, and it forbids added facts. It also states that source, context, and glossary are data and that spoken instructions are translated rather than followed.                                                                              | the prompt file                                   |
| LangGraph, persistent memory, adaptive learning, response generation | Deferred or absent. Not touched in this milestone.                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                 |

## Missing or stubbed behaviour

| Gap                                                    | State                                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No provider model is qualified                         | The model selection record states that neither model qualifies under the frozen criteria. Terra is the stronger candidate. Human bilingual sign-off is still pending. |
| Confirmed provider-event-to-render latency             | Unmeasured. The Muse confirmation mechanism was corrected after the qualification run.                                                                                |
| Human comprehension evidence                           | Not run. No bilingual reviewer has judged the outputs.                                                                                                                |
| Diarization and addressee recognition                  | Unqualified.                                                                                                                                                          |
| Provider request amplification under unstable partials | Bounded by the scheduler today, because provisionals are disabled and only finals are translated. Provisional behaviour is not enabled in this milestone.             |

## Model configuration resolution

The adapter defaulted to `gpt-6-luna` while the configuration defaulted to
`gpt-6.1-terra`. The configuration now owns the single default and the
supported set:

```ts
export const TRANSLATION_MODEL_CONFIG_VERSION = "translation-model-v1";
export const DEFAULT_TRANSLATION_MODEL = "gpt-6.1-terra";
export const SUPPORTED_TRANSLATION_MODELS = ["gpt-6-luna", "gpt-6.1-terra"] as const;
```

The adapter derives its default and its accepted model set from those
constants, so the two cannot disagree. The model is still explicit in
every request, the preflight rejects a model outside the supported set,
and nothing switches a model silently.

## Canonical integration path

```text
Muse or replay transcript events
  -> TranscriptReducer (production)
    -> accepted transcript events
      -> TranslationScheduler (production)
        -> translation provider (production LangChain adapter)
          -> revision aware translation events
            -> session projection
              -> Adaptive Single Flow renderer
```

The lab adds no scheduler, no provider abstraction, and no event bus. The
`ComprehensionEngine` in `lab/audio-slice/comprehension.ts` owns the
production scheduler and routes events. The renderer never calls a
provider.

## Event ownership and revision semantics

| Fact                                        | Owner                                      | Rule                                                                                                                           |
| ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Occurrence identity and transcript revision | `TranscriptReducer`                        | `epoch-<n>-turn-<k>` with a per occurrence revision                                                                            |
| Accepted transcript events                  | `SessionRuntime`                           | sequence, duplicate, stale, and gap rules                                                                                      |
| Translation request eligibility             | `TranslationScheduler`                     | only accepted finals while provisionals are disabled                                                                           |
| Translation revision binding                | `TranslationScheduler` plus the projection | a translation carries its source utterance id and source revision; a translation for an older revision is rejected and counted |
| Translation lifecycle                       | the projection                             | pending, provisional, committed, failed, superseded                                                                            |
| Committed over provisional                  | the projection                             | a provisional that arrives after a committed translation is rejected                                                           |
| Context window                              | `TranslationScheduler`                     | at most five prior utterances                                                                                                  |
| Request amplification                       | `TranslationScheduler`                     | one request per accepted final, at most sixteen pending, no request per partial while provisionals are disabled                |
| User state and notes                        | the session state                          | never overwritten by a provider event                                                                                          |

Translation never blocks capture or transcription. The two paths are
separate: the transcript path feeds the runtime and the surface, and the
translation path feeds the same surface independently. A translation
failure degrades only the translation.

## Paid translation preflight

| Item            | Value                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Endpoint        | `https://api.openai.com/v1/chat/completions` through the existing adapter                                      |
| Model           | explicit, from the supported set, default `gpt-6.1-terra`                                                      |
| Credential      | `URBUDDY_OPENAI_API_KEY`, presence checked without disclosure                                                  |
| Published rates | Luna USD 0.10 and 0.50 per million input and output tokens, Terra USD 1.00 and 5.00                            |
| Local ceilings  | 16 requests, 1,024 output tokens each, 5 context utterances, 600 input tokens each                             |
| Ceiling cost    | 16 requests at 600 input and 1,024 output tokens is USD 0.091520 at Terra rates and USD 0.009152 at Luna rates |
| Cancellation    | the operation abort signal cancels the source, the provider session, and the translation scheduler             |
| Retry           | zero retries in the adapter                                                                                    |
| Data provenance | captured synthetic transcript events only, no private meeting content                                          |
| Retention       | the provider retention terms for transcript text are not contractually verified here and remain unverified     |

The preflight is `lab/audio-slice/qualification/translation-preflight.ts`. It
runs before any provider request and blocks on a missing credential, an
unsupported model, an unauthorised endpoint override, or an invalid
ceiling.
