# ADR-008: Event-driven runtime integration for the Adaptive Single Flow lab

Date: 2026-11-28. Status: accepted for the bounded lab integration. The
final production interaction design remains HOLD and the provider
qualification remains open.

## Context

The accepted audio-backed slice (`5a937fb`) fed the production
`TranscriptReducer` into a trace while the terminal surface derived its
own state from the authored scenario and the playback clock. Two sources
of truth meant that a transcript event and a visible utterance were not
the same fact, so any counterfactual about ordering, delay, or
supersession could not be settled by evidence.

The owner decision for this phase requires one canonical runtime path and
forbids a competing event bus, orchestration framework, persistence
layer, or state-management system.

## Decision

The lab now runs one provider-independent path:

```text
replay adapter
  -> provider events
    -> TranscriptReducer (production)
      -> canonical transcript events
        -> SessionRuntime (production)
          -> session outputs
            -> session projection
              -> Adaptive Single Flow renderer
```

- The replay adapter owns the authored timeline. It converts the fixture
  into provider events, authored discontinuities, translation intents, and
  intelligence events, and it is the only module that reads the
  scenario.
- Occurrence identity stays with the production reducer. The adapter
  correlates a provider turn reference with the utterance identity that
  the reducer assigned, using the provider event that produced the
  accepted transcript event. It never infers identity from playback
  position or from an independent counter.
- `SessionRuntime` keeps sequence, duplicate, and stale rules. The
  projection consumes its outputs.
- The session projection holds domain state: utterances, translations,
  questions, evidence, suggestion lifecycle, gaps, and closure.
- The renderer consumes projected state and dispatches user commands. The
  user state is owned by the user and is never overwritten by provider
  events.
- The replay clock controls event availability only.

## Consequences

- A removed, delayed, corrected, duplicated, or reordered event now has
  an observable consequence in the surface, and the counterfactual suite
  asserts it.
- An authored annotation can no longer arrive before the utterance it
  describes, because both are scheduled from the same utterance timeline.
- A translation is scheduled against the finalized source utterance and
  is rejected when its source revision is older than the visible one.
- A suggestion for changed evidence never reads as ready, and an
  invalidated suggestion never returns to the active response area.
- The lab now has a deterministic, reviewable event-flow reference trace
  that the test suite compares against.
- The renderer is a vendored copy of the adaptive-single-flow surface.
  It is the single candidate integration path for this phase. The frozen
  labs keep their own copies as evidence and are not promoted.

## Rejected alternatives

- A new event bus or state container in the lab: rejected, because the
  production runtime already provides the ordering, duplicate, and stale
  rules and a second mechanism would create two sources of truth again.
- Deriving surface state from the scenario timeline: rejected, because
  playback position is not evidence that an event was delivered.
- Inferring utterance identity from a positional counter in the lab:
  rejected, because overlapping provider turns would mis-associate
  identity.
- Moving the integration into `src/`: deferred, because the production
  interaction design is HOLD and the lab has no qualified provider.
