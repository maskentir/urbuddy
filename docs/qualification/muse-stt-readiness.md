# Real-provider qualification readiness (Muse STT)

Date: 2026-11-28. Status: readiness prepared. No paid request has been
issued. Execution requires explicit owner authorization.

This checklist defines one controlled provider-backed test with
non-private synthetic audio. It does not authorize the test, does not
capture real meetings, and does not expand into memory, learning
personalization, or agent orchestration.

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
