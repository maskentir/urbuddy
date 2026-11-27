# Semantic comparison and snapshot experiment

PR #11 remains on hold. The [controlled model selection report](./model-selection.md)
records the completed comparison and its verdicts. The production prompt
and scheduler policy are unchanged.

## Review of the original run

The Luna run at `c44155b3c482f9ca6ad192f9cec615b13cb128cb` retains its
**12/15** result. Its raw results, stderr, exit status, and case report
were checksum-verified before and after this work. The historical record
contains source revision and context references, with no production HTTP
request-body capture.

The compiled, byte-identical production source and evaluator inputs from
that run were replayed against a loopback HTTP listener. The actual SDK
serialized four bodies for the three cases, including the contextual
case's prior utterance. The ignored `luna-v3-request-replay.ndjson` records
the replay bodies without headers or credentials. In each body the
developer message used `urbuddy-translation-v2`, the user message held
JSON data, and model settings selected Luna, reasoning effort `none`,
JSON object mode and 1,024 completion tokens.

| Case                  | Serialized user evidence                                                                                                                      | Live translation and assessment                                                                                                                                                                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `context-pronoun-001` | Source `Rotate it once Mira approves.`, context `["The TLS certificate expires tomorrow."]`. The live output records `context-0`, revision 1. | `Putar sekali setelah Mira menyetujuinya.` loses the certificate and treats “once” as a single rotation. The wire replay confirms context delivery through the application and SDK serialization path. Production body bytes and the model's internal use of context are unavailable. The evidence supports a context-grounding failure in the model output. |
| `commitment-001`      | Source `I will send the design doc by noon.` and empty context.                                                                               | `Saya akan mengirim dokumen desain itu sebelum tengah hari.` excludes exactly noon. Critical under the authored rubric.                                                                                                                                                                                                                                      |
| `attribution-vet-001` | Source `Rina said the vet may test API v2.4 with a 500 ms timeout, but Omar must approve it.` and empty context.                              | `Rina mengatakan bahwa dokter hewan mungkin akan menguji API v2.4 dengan batas waktu 500 ms, tetapi Omar harus menyetujuinya.` preserves actors, approval obligation and technical details. `Mungkin akan` expresses possibility. The original rubric explicitly required permission, so its recorded FAIL stands.                                           |

Separate source-ambiguity adjudication for `attribution-vet-001` is
**NEEDS HUMAN REVIEW**. “May” can express either authorization or possibility
and the sentence does not uniquely resolve the sense. The approval clause
supports a permission reading while remaining compatible with a prediction.
The output narrows the ambiguity to possibility. The 12/15 score is unchanged.
Both unambiguous critical failures independently block qualification.

## Frozen comparison

Use the concise [candidate prompt](prompts/urbuddy-translation-v3.json) for
both model arms. It asks for supported reference resolution, preservation
of semantic relationships and boundaries, and preservation of genuine
ambiguity. The prompt contains no case terms, verification calls or new
glossary entries. Only the evaluation executable substitutes it.

| Input                                  | SHA-256                                                            | Cases / invocations per model |
| -------------------------------------- | ------------------------------------------------------------------ | ----------------------------: |
| [Corpus v3](corpus/synthetic-001.json) | `e0b446ec9d7f2637beeb69b19a57d4aab99f51d8e94fe310777fdf2f851ab9a4` |                       15 / 16 |
| [Holdout v1](corpus/holdout-001.json)  | `08f175f73daa3fe48401f40f2cd2e9b562c20a2ee34795b7f02922f4cccb3cab` |                         6 / 7 |
| Candidate prompt v3                    | `9e1305ff4a940cad2aa2b4e56c4ce5733ba815be01b96d41c1d58e77b202120a` |                     both arms |

An independent author drafted the holdout without seeing the outputs or
candidate prompt. Integration made the modality cues explicit, corrected
the ambiguous telescope rubric to accept both unresolved readings, and
normalized language codes. The holdout remains unseen by the two provider
model arms. Human bilingual review remains pending.

**Primary gate** for each model and each set independently. Require full
finalized coverage, zero critical errors, and no unresolved work.
Preserve corpus v3 scores under the frozen rubric and report ambiguity
adjudication separately. Only an approved human adjudication can resolve
that item for a future reviewed qualification decision. Score the holdout's explicit permission,
possibility and genuine ambiguity cases on their authored invariants.
Accept natural equivalents. Have an independent reviewer assess sanitized
outputs against frozen rubrics with model labels hidden, then unblind for
comparison. Obtain human bilingual review before qualification. Publish
per-set verdicts, usage, and sample size with full-response and final
publication latency. If both arms pass, use measured latency and cost to
inform the choice. If neither passes, neither qualifies. No live preview
readiness claim follows from a finalized-transcript comparison.

**Proposed bounds**. One run per model, sequential, 23 requests each
(46 total), no retries, same source order and settings, stop on
operational failure. Each request uses the existing 4,096-byte serialized
message bound, an 8,192 input-token budget with framing allowance and
the existing 1,024 completion-token cap. The planning totals per model
are 188,416 input and 23,552 completion tokens.

| Model (reasoning none) | Standard input / output per million | Conservative estimate |
| ---------------------- | ----------------------------------: | --------------------: |
| GPT-6 Luna             |                     USD 0.10 / 0.50 |         USD 0.0306176 |
| GPT-6.1 Terra          |                     USD 1.00 / 5.00 |          USD 0.306176 |
| Combined               |                                     |         USD 0.3367936 |

Proposed authorization cap **USD 0.40 total** at Standard rates. These
are estimates with no cache discount or invoice guarantee. Recheck
pricing and verify the project and effective credential without a probe
before any new run. [Published OpenAI rates](https://developers.openai.com/api/docs/pricing)

Offline preparation commands:

```sh
pnpm build
node tooling/evaluate-translation.mjs --compare gpt-6-luna --env-file .env.example
node tooling/evaluate-translation.mjs --compare gpt-6.1-terra --env-file .env.example
node tooling/evaluate-provisional.mjs --snapshot
```

The completed run used the commands below. They record the execution
procedure and the paths now occupied by its evidence. The authorization
was consumed by that run. Any future run requires fresh authorization
and unused evidence paths.

```sh
(
  umask 077
  set -C
  mkdir -p evaluation/language/results || exit
  for model in gpt-6-luna gpt-6.1-terra; do
    output="evaluation/language/results/compare-v3-${model}"
    test ! -e "${output}.ndjson" && test ! -e "${output}.stderr" &&
      test ! -e "${output}.exit" || exit 3
    node tooling/evaluate-translation.mjs --compare "$model" --env-file .env \
      --live --allow-egress > "${output}.ndjson" 2> "${output}.stderr"
    result=$?
    printf '%s\n' "$result" > "${output}.exit"
    test "$result" -eq 0 || exit "$result"
  done
)
```

Both candidate request paths were verified with an isolated in-process
fake fetch and a sentinel key. Each issued 23 serialized fixture
requests with the same prompt and separate set evidence. No paid request
was made.

## Offline bounded snapshots

The paced harness compares the existing policy with an input sampling
experiment using the same scheduler and synthetic provider. The sampler
opens at 600 ms, keeps at least 1,500 ms between snapshots, allows four
snapshot starts per utterance, and gives each snapshot a 3,300 ms display
age bound. Incoming append-only fixture revisions can advance while a
snapshot request settles. A non-prefix edit immediately clears the snapshot
and invalidates the pending revision. Sink publication verifies provenance
and compatibility again after an asynchronous wait. Snapshot artifacts
show their source revision, capture time and age. The fixture's
space-delimited prefix check is specific to this English workload. An
appended self-correction can change meaning even when it preserves the
text prefix. The experiment does not recognize that case, and it does
not establish an append classifier for languages without word spaces.

| Cadence / provider delay / fixture | Current → snapshot starts | Current → snapshot previews | Final queue current → snapshot |
| ---------------------------------- | ------------------------: | --------------------------: | -----------------------------: |
| 190 / 100 ms, cooperative          |                     7 → 3 |                       6 → 2 |                     10 → 10 ms |
| 190 / 600 ms, cooperative          |                     7 → 3 |                       0 → 2 |                     10 → 10 ms |
| 190 / 600 ms, non-cooperative      |                     6 → 3 |                       0 → 2 |                   110 → 520 ms |
| 470 / 600 ms, cooperative          |                    20 → 4 |                       0 → 3 |                     10 → 10 ms |
| 190 / 1,380 ms, short              |                     7 → 3 |                       0 → 2 |                     10 → 10 ms |
| 190 / 1,380 ms, sustained          |                    13 → 4 |                       0 → 4 |                     10 → 10 ms |
| 190 / 2,920 ms, short              |                     7 → 2 |                       0 → 1 |                     10 → 10 ms |
| 190 / 2,920 ms, sustained          |                    13 → 3 |                       0 → 2 |                     10 → 10 ms |

The paced evaluator reports `previewsPublishedBeforeFinal` and
`firstPreviewPublicationMs`. Each experimental snapshot includes its
age at publication and `visibleDurationMs`, measured until invalidation,
expiry, or finalization in the simulated sink.

| Sustained fixture | Age at publication | Visible duration per snapshot | Cancelled starts, current → snapshot |
| ----------------- | -----------------: | ----------------------------: | -----------------------------------: |
| 190 / 1,380 ms    |           1,400 ms |         120, 140, 140, 590 ms |                               13 → 0 |
| 190 / 2,920 ms    |           2,940 ms |                   100, 120 ms |                               13 → 1 |

The 1,380 and 2,920 ms delays round the recorded full-response median
and p95 to the virtual clock's 10 ms step. In the sustained p95 fixture,
snapshot revision 4 published at 3,700 ms with age 2,940 ms and raw
revision 19. A material polarity and deadline correction at revision 20
cleared it at 3,800 ms. The median fixture clears its displayed revision 4
at revision 12, 2,280 ms. The 470 ms fixture also invalidates an in-flight
snapshot on a negation edit. Guards never published those obsolete
snapshots after their correction. Displayed previews are labeled snapshots.

The sustained median fixture reduced cancelled starts from 13 to zero.
The sustained p95 fixture reduced them from 13 to one. All 16 runs
committed every final and settled all work. Peak provider
concurrency and asynchronous sink concurrency were one in each run.
Committed work kept priority at the next free slot. A non-cooperative
provider could hold that slot longer when a snapshot started near the final.

The snapshot policy remains experimental. A textual prefix can remain
intact through an appended negation, self-correction, or restrictive
condition. A production change would need evidence that its revision
contract handles those cases and a reviewed final-admission budget.
The experiment demonstrates more publications at measured delays and
fewer starts, with fewer publications under the fast control and a
longer final wait for non-cooperative work.
At the sustained p95 point the first snapshot was visible for 100 ms
before correction. Publication alone does not establish reading value.
The echo fixture cannot establish preview semantics. A quiet window
cannot guarantee continuous previews. Token streaming alone leaves the
source-revision validity problem intact.
