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

## Correction of the C1 evidence claims

The loopback server returns `"id: " + source`. That is an English routing
sentinel, not an Indonesian translation. The earlier claim that Indonesian
semantic output was demonstrated is withdrawn. What the loopback actually
establishes is the plumbing: request admission, revision binding, ordering,
failure handling, cancellation, and request bounding. It establishes nothing
about Indonesian wording or meaning.

Where presentation-language behaviour has to be exercised, the authored
bilingual fixtures in `evaluation/language/comprehension-v1/` are used and
are labelled as fixtures. The loopback stub now prefixes its output with
`[fixture]` for the same reason.

The provider request itself is verified to contain the raw source, the
source and target language, the bounded context, and the glossary, and the
system prompt is asserted to forbid following spoken instructions. Those are
deterministic properties and they hold locally.

## Historical semantic evidence reconciliation

The 27 November comparison in `evaluation/language/model-selection.md`
executed 46 provider invocations against the frozen prompt and the frozen
corpora. Its results are preserved and are not repeated by default.

| Arm             | Regression v3 | Holdout v1 | Estimated spend             | Median response |
| --------------- | ------------- | ---------- | --------------------------- | --------------- |
| `gpt-6.1-terra` | 14/15         | 6/6        | USD 0.006205 + USD 0.002745 | about 2.2 s     |
| `gpt-6-luna`    | 12/15         | 5/6        | USD 0.000617 + USD 0.000270 | about 1.5 s     |

Neither arm met the frozen criteria. The cases that still require
adjudication are exactly the ones recorded there:

| Case                  | Arm  | Outstanding decision                                                                                                                  |
| --------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `attribution-vet-001` | both | Both chose possibility where the frozen rubric requires permission. The source ambiguity verdict is NEEDS HUMAN REVIEW for both arms. |
| `holdout-ambiguity`   | both | Both kept the telescope attachment open. The separate source-ambiguity verdict is NEEDS HUMAN REVIEW.                                 |
| `context-pronoun-001` | Luna | Luna omitted the certificate and rendered "once" as a count. Terra passed.                                                            |
| `commitment-001`      | Luna | Luna excluded exactly noon. Terra passed.                                                                                             |
| `holdout-referent`    | Luna | Luna left the blue notebook implicit. Terra passed.                                                                                   |

### Coverage of the new comprehension set against the frozen corpus

| New case                                         | Frozen equivalent      | Verdict           |
| ------------------------------------------------ | ---------------------- | ----------------- |
| `dev-negation-001`                               | `neg-001`, `neg-002`   | duplicate         |
| `dev-double-negative-001`                        | none                   | new               |
| `dev-modality-001` equivalent `dev-indirect-001` | `modality-001`         | duplicate         |
| `dev-numbers-001`                                | `numbers-001`          | duplicate         |
| `dev-correction-001`                             | none                   | new               |
| `dev-context-001`                                | `context-pronoun-001`  | duplicate         |
| `dev-codeswitch-001`                             | `codeswitch-001`       | duplicate         |
| `dev-ambiguous-001`                              | `holdout-ambiguity`    | duplicate         |
| `dev-adversarial-001`                            | `prompt-injection-001` | duplicate         |
| `dev-tech-001`, `dev-conditional-001`            | `conditional-001`      | partial duplicate |
| `holdout-commitment-001`                         | `commitment-001`       | duplicate         |
| `holdout-attribution-001`                        | `attribution-vet-001`  | duplicate         |
| `holdout-conditional-001`                        | `holdout-boundary`     | duplicate         |
| `holdout-units-001`                              | `numbers-001`          | duplicate         |
| `holdout-uncertainty-001`                        | `holdout-possibility`  | duplicate         |
| `holdout-modality-001`                           | `modality-001`         | duplicate         |

Eleven of the seventeen new cases duplicate frozen cases, and the two
genuinely new cases are the double negative and the correction. The new set
is retained as a supplemental set. It is not a second frozen corpus, and it
must not be tuned against.

### Smallest defensible next qualification plan

1. Do not repeat the model comparison. The arms, the prompt, and the
   corpora are unchanged, so repeating them would spend money without
   answering a new question.
2. Adjudicate the outstanding cases first, in the frozen corpus, with a
   bilingual reviewer: `attribution-vet-001` and `holdout-ambiguity` need a
   source ambiguity verdict for both arms, and the three Luna failures
   need a confirmation that Terra is the arm to qualify.
3. Then run one bounded translation-only qualification on the captured
   canonical transcript events, with the production scheduler and adapter,
   with the request, input, and output ceilings enforced, and with the
   supplemental set as a reporting surface rather than a pass gate.
4. Report the critical semantic failures separately from the aggregate
   similarity. Word error rate against the Indonesian reference is a
   secondary signal for an English to Indonesian system, not the primary
   quality measure.
5. Keep the human comprehension requirement open. Nothing in this plan
   replaces a bilingual reader.

### Remaining human adjudication requirements

1. `attribution-vet-001` and `holdout-ambiguity`: a source ambiguity
   verdict for both arms, with the permission rubric applied.
2. A bilingual reviewer for every committed translation produced by the
   next qualification, including whether the Indonesian would be understood
   as the speaker intended.
3. A decision on whether Terra remains the configured default, given that
   neither arm has been qualified.
