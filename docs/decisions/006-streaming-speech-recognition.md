# ADR-006: Streaming speech recognition (Muse first provider)

Date: 2026-11-27. Status: accepted for implementation; live provider
qualification pending owner authorization.

## Context

Speech Perception's second gate needs real-time English transcription
from the merged native capture (interleaved Float32, observed 48 kHz
stereo) and from paced local WAV input, without coupling application
transcript semantics to one vendor's wire protocol.

## Provider contract (verified from Meta documentation, 2026-11-27)

Source: Meta Model API speech-to-text and Voice API reference pages.

- Model `muse-voice-transcribe-1.0`; endpoint
  `wss://api.meta.ai/v1/asr/realtime`.
- First JSON text frame is the handshake; the credential travels in
  `authorization.accessToken` as `Bearer <key>`. The HTTP
  `Authorization` header is ignored on this endpoint. The server
  replies with `{ sessionId }` (the only frame without `type`).
  Handshake within 10 seconds; no audio before the acknowledgement.
- Audio is raw signed 16-bit little-endian mono PCM. `PCM_24KHZ`
  (48,000 bytes/s) is the engine-native rate; `PCM_16KHZ` is resampled
  server-side. Binary frames are paced at approximately real time;
  backlog beyond five seconds ahead of processing is a policy failure.
- Modes: `PUSH_TO_TALK` (default), `ENDPOINTING`, `DIARIZATION`.
  Session length up to 60 minutes; no resume token — a new WebSocket
  is a new session. `endStream` ends input for the whole connection;
  the client keeps reading until the server closes with `1000`.
- Partials with `partialMode: CUMULATIVE` replace the previous
  hypothesis and can retract words. `speechEnd` is a boundary, not
  text. `speechComplete` (keyed by `turnId`) carries the completed
  turn. Turns can overlap; partials carry no `turnId` and belong to
  the most recently opened turn. `speaker` events label the preceding
  span, are session-scoped, and do not identify a verified person.
  No word-level timestamps or confidence scores exist.
- Close codes: `1000` normal, `1008` invalid request or pacing-policy
  failure, `1011` internal/backend failure (session-duration expiry
  uses reason `Max session duration reached`), `1013` rate limited.
  Pricing is $0.18 per audio hour, billed per processed second;
  failures before a transcript and `429` responses are not billed.
  Zero data retention is documented at price parity, but its scope
  was not contractually verified in this slice.

## Decision

- Default mode is `ENDPOINTING`: it detects turn boundaries without
  client-side voice activity detection, which suits live captions.
  `DIARIZATION` is explicitly selected with `--mode diarization`.
  `PUSH_TO_TALK` is not used; Urbuddy does not delimit turns.
- Application-owned contracts live in `src/modules/perception/`:
  `speech.ts` (provider port, canonical transcript events, revision
  reducer, transcription operation) and `convert.ts` (audio
  normalization). Provider wire types, handshake, and error mapping
  stay inside `src/adapters/speech/muse.ts`. No provider registry,
  plugin framework, or automatic failover.
- Canonical identity: Urbuddy assigns utterance IDs per connection
  epoch (`epoch-<n>-turn-<k>`), so a reconnect can never reuse an
  earlier epoch's occurrence identity. Provider turn IDs and session
  IDs are provenance, never Urbuddy identity. Identical text in
  distinct turns stays distinct; duplicate completions with identical
  text are ignored, conflicting completions fail closed; partials
  after final fail closed; unassociable partials fail closed.
- Audio conversion is stateful and owned by perception: downmix to
  mono, 48 kHz → 24 kHz through a 63-tap Blackman windowed-sinc
  low-pass (10.8 kHz) with decimation by two, PCM16 encoding with
  clipping counts. 24 kHz passes through; 16 kHz uses `PCM_16KHZ`
  and avoids upsampling. Other rates are rejected instead of being
  decimated naively. Converter state resets on a capture gap; missing
  audio is never bridged or padded with unrelated samples. The
  provider session opens lazily after the source format arrives, so
  the handshake encoding always matches the converter output. An
  Apple-side converter was rejected for this slice: it would split
  format ownership into the Swift helper while the helper contract
  (validated Float32 frames) already works.
- Continuity validation is shared, not duplicated: `SourceValidator`
  in `perception/audio.ts` enforces format/audio/end sequencing,
  overlap rejection, delivery counters, and tail-gap accounting for
  both `runCaptureSession` and `runTranscription`.
- Transport uses `ws` 8.23.0 (MIT, Node >= 10). Native Node
  WebSocket was evaluated and rejected: it provides no inbound
  payload bound, no termination control suitable for the lifecycle
  tests, and no server implementation for deterministic local
  protocol tests. The adapter enforces an inbound message bound
  plus a 1,024-event queue bound, a bounded outbound buffer
  (default 262,144 bytes, about five seconds at 24 kHz), handshake
  and drain deadlines, and observed socket termination (explicit
  terminate waits up to 2 s for the close to be observed). Sending never
  claims provider processing; `audioProcessedMs` progress is the
  only processing evidence. A send callback only frees kernel
  buffer space; the adapter races it against session termination so
  a stalled callback cannot leak the operation.
- Handshake acknowledgement is per epoch and message-order safe:
  one persistent socket handler routes pre-acknowledgement frames
  to handshake validation and later frames to event processing, so
  events arriving in the same burst as the acknowledgement are
  neither lost nor processed out of order. Provider events queue
  behind their epoch marker, never ahead of it. The acknowledgement
  schema is strict, so an error frame carrying a `sessionId` cannot
  satisfy it. Termination, fatal failure, caller cancellation, and
  explicit shutdown never create new connections; stale sockets are
  ignored by identity; reconnect backoff is owned by the session
  and cancellable. Readiness waits on a fresh per-epoch gate plus a
  real cancellable deadline, not a resolved promise.
- Reconnect is bounded (default two attempts, backoff 250 ms then
  1 s, one retry owner in the adapter) and limited to transient
  (`1011`) and rate-limit (`1013`) closes during active input.
  Protocol rejections (`1008`), authentication failures, fatal
  provider errors, drain timeouts, explicit termination, and caller
  cancellation never reconnect. No audio is replayed: Muse offers
  no resume token and `audioProcessedMs` is processing progress,
  not durable transcript coverage, so replaying the unacknowledged
  tail could lose an unfinished utterance's semantic beginning or
  duplicate context-deficient recognition. Instead a fresh epoch
  resumes with new eligible audio in order, unresolved turns are
  reported per utterance as incomplete evidence before the reducer
  state is discarded, and every epoch boundary emits an explicit
  discontinuity. A connection lost after end-of-input fails
  finalization instead of opening a replacement connection.
  Exactly-once and seamless recovery are not claimed. Unresolved
  turns at normal closure are reported as uncertain coverage,
  never promoted to final.
- WAV input never trusts the declared extent: headers are scanned
  incrementally with a 1 MiB bound, the declared data range is
  validated against the actual file size and the RIFF container
  extent, data is read through the single owned handle with
  frame-aligned position advancement, and a short read fails the
  operation. Regular-file gating uses nonblocking acquisition, so
  a FIFO without a writer is rejected instead of hanging. Realtime
  pacing enforces a minimum half-chunk interval so catch-up bursts
  cannot exceed twice the source rate.
- Credentials arrive only through the `MODEL_API_KEY` environment
  variable, never through arguments, URLs, logs, or fixtures.
  Production connections are restricted to `wss://api.meta.ai`;
  loopback `ws://127.0.0.1`/`localhost` is accepted only through
  the explicit test-only `testLoopbackEndpoint` dependency, never
  through configuration. There is no endpoint override in
  production wiring. Live system audio additionally requires
  child-process authorization, and the CLI discloses cloud
  transmission on stderr in both text and JSON modes. Transcripts
  and audio stay ephemeral; no persistence is introduced.
- Speaker attribution keeps the most recent label per turn as an
  approximation of the documented span semantics (the label covers
  the span since the previous speech event); multi-label turn
  internals are not yet modeled.

## Consequences

- `urbuddy transcribe --file <wav> --allow-egress` paces WAV input
  as a live stream through the same adapter as live capture.
- Deterministic acceptance runs against a local `ws` server; no CI
  job makes paid calls. Real provider verification is a separate
  owner-authorized step (see the PR for the exact live-test command
  and estimate) and is not claimed by this slice.
- Session rotation before the 60-minute provider limit, speaker
  reconciliation across epochs, and production latency measurement
  remain unqualified. FSRS, translation, and memory integrations
  consume the canonical events later without redesign.
