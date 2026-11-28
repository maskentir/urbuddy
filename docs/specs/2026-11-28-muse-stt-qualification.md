# Muse STT real-provider qualification (Urbuddy)

Date: 2026-11-28. Status: engineering prepared. Paid execution is gated
behind explicit owner authorization.

## Decision

- Event-driven runtime integration at `7e93213b04b558205c617ee42de207d9d96c45f6`:
  accepted.
- Further speculative UI experiments: STOP.
- Technology stack: LOCKED.
- Muse STT: primary provider.
- Soniox: planned alternate provider, deferred.
- Clean integration branch preparation: GO.
- Muse qualification engineering preparation: GO.
- Paid execution and external audio transmission: conditional on explicit
  owner authorization.
- Human usability: NOT-RUN.
- Production interaction design and private meeting capture: HOLD.

## Branch

The integration branch is republished from `master` so its reachable
history carries no restricted or unverified binary artifact. The macOS
generated WAV is generated locally and ignored by Git; its fixture script
and manifest stay tracked. The frozen evidence branches stay local and
published as they were.

## Qualification path

```text
WAV source
  -> Muse WebSocket provider (production adapter)
    -> canonical provider events
      -> TranscriptReducer (production)
        -> SessionRuntime (production)
          -> session projection
            -> Adaptive Single Flow renderer
```

The production transcription operation owns the source, the provider
session, and the reducer. The lab adds observation and limits around it,
never a second runtime or a second provider abstraction.

## Fixture

`lab/audio-slice/qualification/reference.json` holds the authored script
and the exact reference transcript. The audio is generated locally by
`generate-audio.mjs` into an ignored directory. The fixture has six
complete turns, natural engineering terminology, an unfamiliar technical
phrase, verified silence between turns, one question, and one
correction. Its duration is bounded to 30 seconds. The runtime path never
reads the reference transcript; a test enforces that.

## Preflight

The run refuses to issue a provider request unless the credential is
available, the provider and model are explicitly selected, the official
endpoint is used, the fixture format is supported, the duration and
attempt limits are inside the budget, the ceiling is inside the owner
budget, and the owner authorization flag is present. Account access and
geographic eligibility can only be confirmed by an authorized request and
are reported as unverified until then.

## Execution limits

Thirty seconds of audio per attempt, three attempts, ninety seconds of
billable audio in total, an expected maximum charge of USD 0.0045, and an
owner ceiling of USD 0.01. The runner counts the audio it actually sends
and aborts before it exceeds the limit. Unrelated paid model calls are
disabled, no audio is replayed, reconnect stays bounded, and no provider
is switched.

## Evidence

The live path is proven against a local loopback server with no paid
request: session establishment, audio frames, partial and final events,
canonical events, runtime acceptance, projection updates, rendered
transcript, credential isolation, explicit failure on disconnect, budget
refusal, and duplicate protection. A real provider run adds the provider
evidence, the transcript evaluation, and the latency measurements.
