# Transcript-only translation evaluation

Run the compiled scheduler against the authored corpus without network access.

```sh
pnpm build
node tooling/evaluate-translation.mjs
```

The offline provider echoes speech verbatim. This checks production scheduler
wiring, context provenance and coverage. Local OpenAI HTTP fixtures separately
check request serialization, status validation, cancellation and usage.
Semantic scoring applies only to actual model outputs. Recognition quality
requires an independent audio-to-translation evaluation.

## Semantic rubric

Review each committed result against `intendedMeaning` and
`incorrectInterpretation` in the corpus. Accept natural equivalents of the
reference. Verify each actor, condition, exception, tense, modality,
quantity and its role, unit, deadline and identifier. Report omissions and
additions that change meaning as critical failures. Prompt-like speech and
delimiter text must remain translated content. A fragment can stay
grammatically incomplete. Preserve recommendation strength, inclusive
deadline boundaries, and the difference between a sufficient condition and
an exclusive one. Speaker labels are approximate attribution.

Japanese-to-Korean and Traditional Chinese-to-English cases exercise
non-English sources, non-Indonesian targets and speech without whitespace
between words. A separate language-model review checked these references against the
source wording and supplies supporting evidence. The references remain
provisional pending independent human bilingual sign-off. Live qualification
requires zero critical semantic failures and complete finalized coverage
on the reviewed corpus. Report noncritical fluency concerns separately.

## Live qualification status

The first authorized run against OpenAI GPT-6 Luna and corpus v3 stopped at
`neg-001`. One local invocation started and exit status was 1. No valid
completion or usage metadata was captured. The retained diagnostic was
`provider failure (INTERNAL)`. HTTP status, error code, and request ID
were unavailable, so the original cause and any billed cost remain
unknown.

The second authorized attempt ran on
`c44155b3c482f9ca6ad192f9cec615b13cb128cb` and exited 0. It published all
16 finals across 15 cases, including the context utterance. The semantic
gate failed on certificate rotation, the inclusive noon deadline, and
permission to test the API. Human bilingual sign-off is pending. The
provider reported 3,824 input and 388 output tokens. The full-response
median was 1,375 ms across 16 invocations, and the nearest-rank p95 was
2,919 ms. These are transcript-only measurements. All 16 exceeded
the 600 ms delay at which the offline scenarios starved previews.

Both authorizations are consumed. Any later attempt requires fresh owner
authorization.

The existing runner fixes corpus v3, the production destination, Luna with
`reasoning_effort: none`, zero retries, up to 16 invocations, and up to
1,024 completion tokens per invocation. It forwards sanitized provider
failure details when available and stops on operational failure. Review
the current public rates and authorized spend before a future run.
[OpenAI model and rates](https://developers.openai.com/api/docs/models/gpt-6-luna)

With fresh authorization and the dedicated `URBUDDY_OPENAI_API_KEY` available
locally, use an unused evidence filename to preserve the first attempt.
The evaluator shares the CLI environment-file loader.
Live mode fixes the authorized production recipient, Luna model and v3
case languages even when the environment configures different defaults.

```sh
pnpm build
umask 077
mkdir -p evaluation/language/results
node tooling/evaluate-translation.mjs --env-file .env --live --allow-egress \
  > evaluation/language/results/luna-synthetic-future.ndjson \
  2> evaluation/language/results/luna-synthetic-future.stderr
printf '%s\n' "$?" > evaluation/language/results/luna-synthetic-future.exit
```

Record the exact commit, Node version, model, prompt and corpus versions,
language configuration, glossary scope, request and coverage counts,
reported usage, and reviewed meaning verdicts. Retain sanitized metrics
and synthetic case identifiers in the PR evidence. Keep execution output
in the ignored results directory and exclude credentials, private speech,
and provider error bodies from evidence. Abort on cancellation, incomplete
cleanup or budget exhaustion and report missing outcomes.

Report transcript event to invocation, invocation to full response,
publication attempt and drain independently. The 1.5-second first useful
translation and 2.5-second final contextual translation targets remain
aspirational audio-to-output p95 goals. This transcript-only run excludes
audio capture and recognition delay. Model invocation returns the full
response, while provisional translation uses successive source revisions.

## Offline provisional readiness

On the unchanged production scheduler, run `node tooling/evaluate-provisional.mjs`
after the build. The harness uses a virtual clock with 10 ms steps and a
fixed-delay echo provider. It tracks whether a current revision actually
reaches the sink before finalization. Echo content establishes publication
timing and revision correctness. Semantic usefulness requires model output.

The retained initial Muse qualification runs had 397 partials over 17 finals,
411 over 18, and 123 over six. The 21-revision fixture reflects that density.
The recorded events do not include per-revision arrival timestamps. The
190 ms and 470 ms intervals and the 100 ms and 600 ms response delays are
test assumptions. The fixture includes a same-length correction and a
negation correction. The final arrives 90 ms after the last partial.

| Revision interval (ms) | Response (ms) | Cancel behavior     | Preview starts | Cancelled | Stale rejections | Late responses | Current previews | First preview (ms) | Final admission (ms) | Final publication (ms) |
| ---------------------: | ------------: | ------------------- | -------------: | --------: | ---------------: | -------------: | ---------------: | -----------------: | -------------------: | ---------------------: |
|                    190 |           100 | Cooperative         |              7 |         1 |                1 |              0 |                6 |                500 |                   10 |                    110 |
|                    190 |           600 | Cooperative         |              7 |         7 |                7 |              0 |                0 |                  — |                   10 |                    610 |
|                    190 |           600 | Settles after abort |              6 |         0 |                6 |              6 |                0 |                  — |                  110 |                    710 |
|                    470 |           600 | Cooperative         |             20 |        20 |               20 |              0 |                0 |                  — |                   10 |                    610 |

Stale rejections include rejected cancelled revisions. Late responses count
successful returns after the scheduler signaled abort. Final timings start
at the synthetic final event. Every scenario committed its single final.
All fixture calls settled, and there were zero unresolved invocations,
unresolved publications, or publication failures.

Sustained revisions starved previews at 600 ms response time. This is a
provisional availability limitation. The exercised revision and final
coverage checks passed. A narrow follow-up experiment would admit previews
after a short revision-free window while keeping the publication guard and
committed priority. That should reduce repeated starts during fast speech.
A continuing utterance with no pause can still yield zero previews. Assess
whether useful pauses occur before changing admission. Use final-only
evidence for initial semantic qualification and withhold a live preview
performance claim.
