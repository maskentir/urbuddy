# Real-provider qualification readiness (Muse STT)

Date: 2026-11-28. Status: readiness prepared and executable. No paid
request has been issued. Execution requires explicit owner authorization.

This checklist defines one controlled provider-backed test with
non-private synthetic audio. It does not authorize the test, does not
capture real meetings, and does not expand into memory, learning
personalization, or agent orchestration.

## Implementation

| Piece                            | Location                                                 |
| -------------------------------- | -------------------------------------------------------- |
| Qualification runner             | `lab/audio-slice/qualification/run-muse.tsx`             |
| Preflight                        | `lab/audio-slice/qualification/preflight.ts`             |
| Provider telemetry and limits    | `lab/audio-slice/qualification/instrumented-provider.ts` |
| Fixture and reference transcript | `lab/audio-slice/qualification/reference.json`           |
| Local fixture generator          | `lab/audio-slice/qualification/generate-audio.mjs`       |
| Evaluation harness               | `lab/audio-slice/qualification/evaluate.ts`              |
| Loopback proof of the live path  | `lab/audio-slice/qualification/live-path.test.ts`        |

## Launch command

```sh
# 1. generate the local fixture audio (ignored by Git)
pnpm lab:muse-qualification:fixture

# 2. preflight only, no request issued
pnpm lab:muse-qualification -- --env-file .env

# 3. authorized run, at most 30 s of audio per attempt
pnpm lab:muse-qualification -- --env-file .env --owner-authorized --authorization <owner-reference>

# 4. evaluate the recorded run
pnpm lab:muse-qualification:evaluate -- <trace.jsonl>
```

## What exists today

| Area                  | State in this repository                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Muse STT adapter      | `src/adapters/speech/muse.ts`, production contract in `src/modules/perception/speech.ts`                                                                                                                                   |
| CLI entry             | `urbuddy transcribe` in `src/presentation/cli.ts`                                                                                                                                                                          |
| Credential resolution | `URBUDDY_META_API_KEY` from the process environment or an explicitly selected `--env-file`                                                                                                                                 |
| Model selection       | `URBUDDY_STT_MODEL` or `--stt-model`; only `muse-voice-transcribe-1.0` is supported                                                                                                                                        |
| Provider selection    | `--provider muse` or `URBUDDY_STT_PROVIDER`; any other value fails closed with `CONFIG_INVALID`                                                                                                                            |
| Translation           | `src/modules/language/translation.ts` with the OpenAI adapter (`URBUDDY_OPENAI_API_KEY`, `gpt-6-luna` default, `gpt-6.1-terra` optional)                                                                                   |
| Soniox                | No adapter exists in `src/`. The architecture table lists it as `selected`. This is a concrete mismatch: an adapter has to be written before Soniox can be qualified, and it must never become a silent fallback for Muse. |
| Live audio capture    | `src/adapters/audio/capture-source.ts`, requires `--allow-child` and `--allow-native`                                                                                                                                      |

## Configuration requirements

```sh
# Explicit credential file, never an inline secret
urbuddy transcribe \
  --env-file /absolute/path/to/urbuddy.env \
  --provider muse \
  --stt-model muse-voice-transcribe-1.0 \
  --mode endpointing \
  --file lab/audio-slice/audio/meeting.wav \
  --allow-egress \
  --json
```

- `--allow-egress` is mandatory for any network call. Without it the
  command fails before the provider is contacted.
- `--env-file` is the explicit file selection. The credential never
  appears in arguments, URLs, logs, or committed fixtures.
- The model must be supported before source acquisition starts, so an
  invalid `--stt-model` fails without touching the audio.

## Credential availability check without disclosure

```sh
# Prints nothing, exits 0 when the credential is present.
node -e 'process.stdout.write(process.env.URBUDDY_META_API_KEY ? "present\n" : "absent\n")'
```

The check reports presence only. No secret, prefix, length, or hash is
logged, and the value never enters the trace or the commit.

## Request and duration limits

- Synthetic input: `lab/audio-slice/audio/meeting.wav`, generated locally
  by `lab/audio-slice/tools/generate-audio.mjs` from authored text. It
  contains no personal, private, or third-party meeting content.
- Audio budget: 30 seconds maximum for the first controlled run. The
  provider bills per processed second, so a 30 second run is the cost
  ceiling for the attempt.
- Provider session limit: 60 minutes. Session rotation before that limit
  is unqualified and is out of scope for the first run.
- WAV input is paced as a live stream, so the run takes wall-clock time
  equal to the audio duration.

## Expected usage and cost

| Item            | Value                                                    | Confidence                                                |
| --------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Billed audio    | 30 s processed                                           | Derived from the run budget                               |
| Price           | USD 0.18 per audio hour, billed per processed second     | ADR-006, vendor documentation                             |
| Cost ceiling    | USD 0.0015 per run                                       | Derived from the price and the budget                     |
| Failed attempts | Failures before a transcript and HTTP 429 are not billed | ADR-006, vendor documentation, not contractually verified |
| Total attempts  | At most 3 attempts per authorization                     | Owner decision                                            |

## Cancellation and retry

- Cancellation: Ctrl-C aborts the operation through its owned
  `AbortController`. The source iteration and the provider session are
  aborted together, the transport is terminated, and the process exits
  non-zero. A cancelled run bills only the audio already processed.
- Reconnect: bounded to two attempts with 250 ms then 1 s backoff, and
  only for provider close codes `1011` and `1013`. No audio is replayed
  because Muse has no resume token, so a reconnect can lose the semantic
  beginning of an unfinished utterance and can never duplicate context.
- Protocol rejections (`1008`), authentication failures, fatal provider
  errors, drain timeouts, explicit termination, and caller cancellation
  never reconnect.

## Failure isolation

- The transcription operation owns one abort signal shared by source
  iteration and the provider session. A provider failure fails that
  operation and leaves the rest of the application untouched.
- Translation is a separate, optional stage. A translation failure
  degrades translation output while the original transcription stays
  available. It never blocks or rewrites the transcript.
- The session runtime records gaps and uncertain coverage. A run that
  reports a discontinuity is not a qualified run, regardless of exit
  code.

## Data handling and retention

- Raw audio is ephemeral. Urbuddy introduces no persistence for it.
- The credential travels in the WebSocket handshake frame, never in a
  URL, argument, log line, or fixture.
- Muse documents zero data retention at price parity. The scope of that
  claim was not contractually verified in this slice, so it is recorded
  as unverified.
- The committed WAV is local synthetic audio. Sending it to the provider
  is still an egress of local content and therefore requires explicit
  authorization.

## Observable success criteria

1. The process exits 0.
2. The final transcript contains the expected authored sentences, with no
   silent substitutions.
3. The summary reports at least one final and a partial count above zero.
4. The reported discontinuity count is 0.
5. `audioProcessedMs` reaches the end of the input.
6. The recorded latency distribution is written to the evidence
   directory, with p50, p95, and maximum separated from theoretical
   scheduling bounds.
7. No credential material appears in the transcript, the trace, the
   summary, or the logs.

## Observable failure criteria

1. A non-zero exit code, or a failed handshake, drain timeout, or
   protocol close.
2. A missing final, or a final whose text differs from the expected
   sentence without an explicit correction event.
3. Any reported discontinuity.
4. Any provider fallback, automatic retry against a different provider,
   or silent provider switch.

## Execution gate

The run is authorized only after the owner confirms the credential, the
audio budget, and the cost ceiling. Until then this document is
readiness only, and the qualification status stays OPEN.

## Requalification preflight (2026-11-28, after the correction cycle)

The correction cycle fixed the evaluator, the timing model, the turn
alignment, the render instrumentation, the audio truncation, and the
progress renders. All of it is verified locally through the loopback
server with no paid request. One bounded requalification attempt is
prepared and waits for a new explicit owner authorization.

### What changed since the first attempt

| Change                 | Effect                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evaluator corrected    | Word error rate 11.111 % to 6.944 %, with separate substitution, deletion, and insertion counts                                                                                                                               |
| Timing model separated | Session initiation, websocket establishment, audio transmission, provider receipt, reducer acceptance, runtime application, projection update, render request, and render completion are distinct rows on one monotonic clock |
| Turn alignment         | Content based, supporting merged, split, missing, inserted, and ambiguous mappings                                                                                                                                            |
| Render instrumentation | A request and a completion are separate rows, the completion is confirmed only when the written output holds the requested utterance and revision                                                                             |
| Audio truncation       | The operation limit is the session watchdog, not the audio ceiling, so the whole fixture is transmitted                                                                                                                       |
| Progress renders       | Progress events no longer cause a content render                                                                                                                                                                              |
| Vocabulary             | The configured domain vocabulary reaches the provider handshake                                                                                                                                                               |

### Local verification without spending money

| Check                                     | Result                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Audio transmitted through loopback        | 29.533 s, the whole fixture                                             |
| Source frames to provider bytes           | exact, including the last partial frame                                 |
| End of stream signalled                   | yes                                                                     |
| Provider finalization                     | 6 finalized utterances                                                  |
| Unexpected discontinuities                | 0                                                                       |
| Stale and duplicate canonical state       | 0 and 0                                                                 |
| Render requests and confirmed completions | 47 requests, 18 confirmed content renders, 29 unconfirmed clock renders |
| Provider event to confirmed render        | 2.5 ms to 3.7 ms over 6 samples                                         |
| Vocabulary in the handshake               | 16 terms, confirmed on the wire                                         |

### Before and after over the same event sequence

| Measure           | Previous policy             | Current policy              |
| ----------------- | --------------------------- | --------------------------- |
| Renders           | 294                         | 47                          |
| Process CPU       | user 2801 ms, system 163 ms | user 1750 ms, system 177 ms |
| Transmitted audio | 29.533 s                    | 29.533 s                    |
| Discontinuities   | 0                           | 0                           |

### Authorization boundary

The owner authorization `owner-approval-2026-11-28-attempt-1` applied to
attempt 1 only and has been consumed. No further provider request has
been made.

| Item                            | Value                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact launch command            | `pnpm lab:muse-qualification -- --env-file .env --owner-authorized --authorization <new-owner-reference>`                                                                           |
| Maximum audio per attempt       | 30 s                                                                                                                                                                                |
| Attempts used so far            | 1 of the 3 permitted by the original ceiling                                                                                                                                        |
| Cumulative audio transmitted    | 28.68 s of the 90 s billable ceiling                                                                                                                                                |
| Cumulative estimated charge     | USD 0.001434 of the USD 0.01 owner ceiling                                                                                                                                          |
| New attempt cost estimate       | USD 0.001477 for 29.533 s, or USD 0.0015 rounded up                                                                                                                                 |
| Remaining owner-approved budget | USD 0.008566, and 2 attempts                                                                                                                                                        |
| Vocabulary biasing              | enabled, predeclared, `storage-observability-domain-v1`, 16 domain terms, independent of the reference transcript                                                                   |
| Data provenance                 | Locally authored text spoken by macOS system voices. No personal, private, confidential, or third-party meeting content.                                                            |
| Egress conditions               | One websocket to `wss://api.meta.ai/v1/asr/realtime`. The credential travels only in the handshake frame. No other paid model is called and no translation provider is constructed. |
| Fixture                         | Unchanged from the first attempt, sha256 `02531e349be6bd360c3dbb58d862d1c87b59d9b4830fc2f65f8b25f8bee7ecfc`                                                                         |

A new explicit owner authorization is required before this command runs.

## Known issues

| Issue                                                                                                                                                                                                                                                     | State                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One repository gate run reported a single failing test while it executed concurrently with a production build and a local loopback server. Two subsequent isolated runs passed 337 of 337. The failing assertion was not captured in the captured output. | **Unresolved.** It is not reproduced in isolation, so it is not claimed to be fixed, and no test was weakened to hide it.                                      |
| The first attempt transmitted 28.68 s of the 29.53 s fixture because the operation limit was the audio ceiling.                                                                                                                                           | Fixed in the correction cycle. The operation limit is now the session watchdog and the whole fixture is transmitted.                                           |
| The first report stated an edit distance of 22.                                                                                                                                                                                                           | Corrected. The original edit distance was 8; 22 was the sum of the incorrectly reported operation counts.                                                      |
| The first report paired reference segments with provider turns by index.                                                                                                                                                                                  | Corrected. The mapping now comes from a transcript alignment.                                                                                                  |
| The first report recorded a render request as a render observation.                                                                                                                                                                                       | Corrected. A request and a completion are separate rows and a completion is confirmed only when the written output holds the requested utterance and revision. |

## Limits and their boundaries

| Limit                                  | Value                    | Enforced by                                                                                                                     |
| -------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Transmitted audio per attempt          | 30 s                     | The instrumented provider counts the bytes it sends and refuses to exceed the ceiling                                           |
| Cumulative transmitted audio           | 90 s                     | The local attempt ledger, across process invocations                                                                            |
| Cumulative estimated charge            | USD 0.01                 | The local attempt ledger, across process invocations                                                                            |
| Attempts                               | 3                        | The local attempt ledger, across process invocations                                                                            |
| Provider handshake                     | 10 s                     | The production Muse adapter                                                                                                     |
| Provider finalization drain            | 15 s                     | The production Muse adapter                                                                                                     |
| Session watchdog                       | 60 s by default          | The runner, as the operation limit                                                                                              |
| Connection and finalization allowances | 15 s and 15 s by default | The runner only. These are watchdog allowances that must cover the adapter boundaries. They are not separate provider timeouts. |

The attempt ledger lives in a local ignored directory. Every attempt
records its owner authorization reference, the transmitted seconds, the
estimated charge, the fixture checksum, and the trace path. A command
line flag alone is not an authorization: the run is refused when the
recorded cumulative usage would exceed a ceiling.
