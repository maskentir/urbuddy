# Event-driven runtime integration (Urbuddy)

Date: 2026-11-28. Status: approved by owner decision. Scope: bounded lab
integration on top of the frozen audio-slice evidence.

## Decision

- Adaptive Single Flow: accepted primary interaction candidate.
- Audio-backed vertical slice: accepted as lab evidence.
- Speculative interaction redesign: STOP.
- Additional standalone UX prototypes: NOT AUTHORIZED.
- Event-driven runtime integration: GO.
- Existing technology stack: LOCKED.
- Final production interaction design: HOLD.
- Human usability: NOT-RUN.
- Paid API calls and private meeting capture: NOT AUTHORIZED.

The product moves from design exploration toward a functional integrated
product. The stop condition is explicit: the accepted Adaptive Single Flow
interface must be driven by canonical runtime events instead of an
independent scenario clock. No new standalone prototype, no merge to
master, no paid provider execution, and no fabricated human usability
evidence.

## Frozen evidence

The accepted audio-slice revision is
`5a937fbe9ebf5ec09349d54c0023c90d81067755`. Master, the convergence lab,
the adaptive-single-flow lab, and the formal evaluation kit stay frozen.
The integration branch starts from that revision and never rewrites it.

The audio-slice diff is reviewed for sensitive information, generated
artifacts, and redistribution rights. Offline system-generated speech does
not automatically grant public redistribution rights, so the branch is not
published until artifact publication eligibility is established. Until
then the exact audio revision is retained locally and the publication
blocker is reported.

## Architecture requirement

One canonical runtime path, provider-independent:

```text
provider adapter
  -> canonical transcript events
    -> TranscriptReducer
      -> asynchronous translation and intelligence events
        -> session projection
          -> Adaptive Single Flow renderer
```

The renderer consumes projected session state and dispatches user
commands. The renderer and the session projection never read scenario
timelines to infer what happened. The replay clock controls event
availability, not domain state. Authored fixtures enter through explicit
replay adapters. Existing event types and public boundaries are preserved.
No competing event bus, orchestration framework, persistence layer, or
state-management system is introduced.

## Ownership

| Concern                          | Owner                                                     |
| -------------------------------- | --------------------------------------------------------- |
| Transcript revisions             | `TranscriptReducer` (production) then `SessionRuntime`    |
| Speaker and participant identity | Provider-derived labels, projected into the roster        |
| Translation state                | Translation events carrying source utterance and revision |
| Question identity                | Question events keyed by question id                      |
| Evidence references              | Resolution from turn reference to canonical utterance id  |
| Suggestion lifecycle             | Generation and invalidation counters in the projection    |
| User-authored notes              | User state, never overwritten by provider events          |
| User-selected question           | User state                                                |
| Capture gaps                     | Discontinuity events plus runtime sequence gaps           |
| Session closure                  | Closure event and runtime completion                      |

Provider-derived state is projected from accepted events. User interaction
state is controlled by the user. Wall-clock time alone never establishes
transcript or response validity.

## Asynchronous semantics

Partial updates, finals, corrections, duplicates, out-of-order events,
delayed translations, translations targeting superseded revisions, delayed
suggestions, suggestions based on superseded evidence, changed technical
assumptions, capture discontinuities, cancellation, and session
termination must all be exercised. Late results never silently overwrite
newer state. Invalidated suggestions never return to the active
speak-ready area because of delayed or reordered events. Where correctness
cannot be established, uncertainty is exposed and unsafe activation is
prevented. Confidence is never fabricated.

## Counterfactual evidence

Mandatory tests: missing event, delayed event, changed payload, revised
evidence, late stale result, citation identity, duplicate notices, and an
unknown scenario that runs with different speakers, text, identifiers, and
timings without scenario-specific modifications.

## Duplication control

Duplicated session, screen, and scenario logic across the labs is
identified, not promoted. Frozen lab evidence is preserved. One candidate
integration path uses the existing reusable abstractions. No broad
refactor, no new framework, database, provider, or technology selection
exercise. A concrete mismatch is documented before any replacement.

## Instrumentation

Internal timestamps use a monotonic clock and cover provider event arrival,
reducer acceptance, projection update, render observation, translation
event arrival, suggestion lifecycle transitions, and cancellation and
shutdown completion. Sample counts and latency distributions include p50,
p95, and maximum where meaningful. Measured values stay separate from
theoretical scheduling bounds. The `afplay` software clock is never
labelled as measured physical audio position; physical playback alignment
stays UNVERIFIED unless the playback mechanism can observe it. No new
playback engine is introduced for a lab metric.

## Accepted UX

Adaptive Single Flow is not redesigned. Comprehension-first presentation,
contextual question assistance, the C / R / Esc primary interaction,
stable selection, no focus theft, user-authored note preservation, explicit
gaps and uncertainty, evidence identity, stale suggestion quarantine, and
meeting closure all stay as accepted. Only functional regressions and
demonstrated safety defects are fixed.

## Real-provider qualification readiness

Existing Muse STT, Soniox, translation scheduler, and model integration
implementations are inspected to define one controlled provider-backed test
with non-private synthetic audio: configuration requirements, credential
availability checks that reveal no secrets, explicit provider selection,
request and duration limits, expected usage and cost ceilings or clearly
identified unknowns, cancellation and retry policies, failure isolation,
data handling and retention, and observable success and failure criteria.
No paid request is issued, no provider is silently switched, and no real
meeting is captured.

## Deliverables

1. Code-backed architecture gap analysis.
2. Exact integration branch and commit.
3. Before-and-after data-flow diagram.
4. Event ownership and revision semantics.
5. Counterfactual test results.
6. Existing regression and repository gate results.
7. Actual runtime latency measurements.
8. PTY execution evidence.
9. Remaining limitations.
10. One-command offline integrated runtime launch.
11. Real-provider qualification readiness checklist.
12. Explicit GO/HOLD recommendation.
