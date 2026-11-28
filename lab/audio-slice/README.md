# Audio-backed vertical slice (bounded lab)

One reproducible slice: audible English engineering discussion (local
macOS `say` synthesis, committed WAV) with synchronized comprehension
assistance on the Adaptive Single Flow surface. Offline, no credentials,
no providers, no persistence.

You are Priya (SRI). Amara asks the team; one question is ambiguous
(Jonas or Priya), one is directed at Jonas. Nothing is transmitted.

## Runtime path

The surface is driven by canonical runtime events, not by a scenario
clock:

```text
replay adapter
  -> provider events
    -> TranscriptReducer
      -> canonical transcript events
        -> SessionRuntime
          -> session outputs
            -> session projection
              -> Adaptive Single Flow renderer
```

- `adapter.ts` turns the authored fixture into provider events, authored
  discontinuities, translation intents, and intelligence events. It is the
  only module that knows the scenario timeline.
- `feed.ts` drives the production `TranscriptReducer` and
  `SessionRuntime`, and instruments every stage with a monotonic clock.
- `projection.ts` maps accepted events, translation events, and
  intelligence events into domain state.
- `session.ts` owns user interaction state only.
- `screen.tsx` renders projected state and dispatches user commands. It
  never reads the scenario, and neither does the projection.

The replay clock decides which events are available. It never decides
what the domain state is.

## Commands

```sh
# Run the slice (interactive terminal, macOS afplay)
pnpm lab:audio-slice

# Counterfactual and asynchronous-semantics evidence
pnpm lab:audio-slice:test

# Regenerate the deterministic text frames
FORCE_COLOR=3 pnpm lab:audio-slice:capture

# Regenerate the deterministic event-flow reference trace
pnpm lab:audio-slice:reference
```

Space pauses and resumes audio and the replay clock together. `q` or
Ctrl-C stops audio and writes a runtime trace under `trace/`.

Regenerate audio only if `audio/meeting.wav` is missing:

```sh
node lab/audio-slice/tools/generate-audio.mjs
```

## Muse STT qualification

The same runtime path can be driven by the real production Muse adapter
instead of the replay adapter:

```text
WAV source -> Muse WebSocket provider -> canonical provider events
  -> TranscriptReducer -> SessionRuntime -> session projection
    -> Adaptive Single Flow renderer
```

The qualification lives in `lab/audio-slice/qualification/`:

| File                       | Responsibility                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `reference.json`           | Exact reference transcript and technical-term list. Read by the evaluation harness only.                                               |
| `generate-audio.mjs`       | Generates the local fixture audio and its manifest. The audio is ignored by Git.                                                       |
| `preflight.ts`             | Credential, provider, model, endpoint, format, limits, budget, and owner-authorization checks.                                         |
| `instrumented-provider.ts` | Production provider decorator that timestamps provider events and audio frames and enforces the audio and budget limits.               |
| `run-muse.tsx`             | The live qualification runner and trace writer.                                                                                        |
| `evaluate.ts`              | Word error rate, technical-term accuracy, omissions, insertions, and latency report.                                                   |
| `live-path.test.ts`        | The whole live path against a local loopback server, including failure, cancellation, budget, and duplicate handling. No paid request. |

```sh
# Generate the local fixture audio (ignored by Git)
pnpm lab:muse-qualification:fixture

# Preflight and, only with explicit owner authorization, the paid run
pnpm lab:muse-qualification -- --env-file .env --owner-authorized --authorization <reference>

# Evaluate a recorded run
pnpm lab:muse-qualification:evaluate -- <trace.jsonl>
```

The run transmits at most 30 s of synthetic audio per attempt, allows at
most three attempts, and estimates the charge from the audio it actually
sends. It issues no request unless the preflight passes, including the
explicit owner authorization. Translation and intelligence assistance are
disabled for a qualification run and the surface says so.

## Evidence

- `frames/*.ansi` are the canonical frame artifacts. They are rendered
  from the runtime at fixed replay positions and are reproducible with
  `pnpm lab:audio-slice:capture`. PNG renders were produced by a tool
  outside this repository, so they are not regenerable here and are not
  carried on the integration branch; the frozen revision `5a937fb`
  retains them.
- `trace/reference.jsonl` is the deterministic event flow of the replay.
  The test suite compares the regenerated flow against that file, so any
  change in event order, timing, or content fails the suite.
- `trace/run-*.jsonl` files are runtime traces with measured monotonic
  timings. They are not committed.

## Limits

- Speech recognition is not used. Transcript and translation content is
  authored replay data and every discontinuity says so on the surface.
- The replay clock is a software clock: monotonic elapsed time since
  `afplay` was spawned. It is not a measurement of physical audio
  position, so playback alignment stays UNVERIFIED.
- Translation timing is authored, not measured provider latency.
- Human usability is NOT-RUN. Production interaction design is HOLD.
