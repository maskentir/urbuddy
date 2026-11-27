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
grammatically incomplete. Speaker labels are approximate attribution.

Japanese-to-Korean and Traditional Chinese-to-English cases exercise
non-English sources, non-Indonesian targets and speech without whitespace
between words. A separate language-model review checked these references against the
source wording. Human bilingual sign-off is pending, so treat this subset
as provisional. Live qualification
requires zero critical semantic failures and complete finalized coverage
on the reviewed corpus. Report noncritical fluency concerns separately.

## Proposed live qualification

Get explicit owner authorization for the exact corpus, model, run count,
recipient and cost cap before running. Use only the committed synthetic
corpus. The one planned transcript run uses OpenAI GPT-6 Luna with
`reasoning_effort: none`, no retries, at most 16 invocations including
the prior context utterance, and at most 1,024 completion tokens per
invocation. It uses each case's source and target configuration. At
current Standard pricing of USD 0.10 per million input tokens and USD 0.50
per million output tokens, even the model's full context window per
invocation would exceed the proposed cap. For this corpus the outgoing
request is bounded instead by the authored source strings, the fixed
prompt and an enforced 4,096-byte bound on serialized messages. A conservative estimate of 8,192 input
tokens per invocation plus the hard output cap gives about USD 0.0095
at Standard rates. The USD 0.05 proposal remains subject to authorization.
Verify prices and enable owner-approved project spending controls before
execution. [OpenAI model and rates](https://developers.openai.com/api/docs/models/gpt-6-luna)

With authorization and the dedicated credential already injected, run once:

```sh
pnpm build
umask 077
mkdir -p evaluation/language/results
node tooling/evaluate-translation.mjs --live --allow-egress \
  > evaluation/language/results/luna-synthetic-001.ndjson
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
