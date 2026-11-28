# Milestone 5 production convergence plan

Date: 2026-11-28. Status: experimental implementation authorized.

The project owner approved the implementation-order exception under
`OWNER-M5-2026-11-28`, from master
`ef5e212836de56736380eb4de41b094b42cfdf09`. Milestone 4 semantic
qualification remains open. All existing acceptance criteria and
release gates apply to both milestones. The decision grants permission
to implement Milestone 5 experimentally before Milestone 4 completes.
Verification uses synthetic data and local loopback. Paid requests,
private meeting capture, and private transmission require separate
authorization. This decision confers no qualification or production
readiness status.

The objective is the smallest path that promotes the accepted Adaptive
Single Flow design into the existing production application, without the
final architecture depending on a qualification runner or on fixture driven
lab state.

## Ownership map

| Concern                                                                  | Owner today                                                  | Target owner                     | Action                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------- |
| Composition root and process lifecycle                                   | `src/bootstrap/composition.ts`                               | unchanged                        | wire the promoted surface there, and nowhere else                                             |
| Domain contracts and lifecycle                                           | `src/modules/*`                                              | unchanged                        | no new module for the surface itself                                                          |
| Speech provider, translation provider, audio source                      | `src/adapters/*`                                             | unchanged                        | reuse as is                                                                                   |
| Evidence store, logging, paths                                           | `src/platform/*`                                             | unchanged                        | reuse as is                                                                                   |
| Terminal rendering and key handling                                      | `src/presentation/*`                                         | **promote the lab surface here** | move the rendering and input concerns, not the runtime                                        |
| Session state projection for the terminal                                | `src/presentation/*` or `src/modules/session/*`              | decide once                      | the projection is domain state and belongs in a module, the rendering belongs in presentation |
| Event-driven runtime integration                                         | `lab/audio-slice/feed.ts`, `projection.ts`                   | `src/modules/session/*`          | promote the canonical event path, not the lab wiring                                          |
| Comprehension engine                                                     | `lab/audio-slice/comprehension.ts`                           | `src/modules/language/*`         | the scheduler already lives there, so the engine becomes a thin module level coordinator      |
| Qualification harness, ledger, evaluator, fixture audio, capture scripts | `lab/audio-slice/qualification/*`, `lab/audio-slice/tools/*` | **stay in the lab**              | never promoted                                                                                |
| Replay fixtures and the authored scenario                                | `lab/audio-slice/scenario.ts`, `lab/audio-slice/fixture.ts`  | **stay in the lab**              | used by tests only                                                                            |
| The frozen semantic corpus and the model comparison                      | `evaluation/language/*`                                      | unchanged                        | evidence, not runtime                                                                         |

## Reusable lab components

| Component                          | Reusable content                                                                                                                             | Not reusable                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lab/audio-slice/feed.ts`          | the canonical event path: accepted transcript events into the session runtime into a projection                                              | the authored schedule plumbing, the `TurnRegistry` used only for replay turn identity                   |
| `lab/audio-slice/projection.ts`    | the revision-aware translation lifecycle and the evidence resolution rules                                                                   | the authored intelligence events and the question and suggestion model, which are not product scope yet |
| `lab/audio-slice/screen.tsx`       | the comprehension-first layout, the C, R, and Esc interaction, the stable selection, no focus theft, the explicit gap and uncertainty states | the authored question and suggestion content                                                            |
| `lab/audio-slice/comprehension.ts` | the rule that translation follows a runtime accepted event                                                                                   | the lab specific harness wiring                                                                         |
| `lab/audio-slice/qualification/*`  | nothing                                                                                                                                      | the whole directory is qualification tooling                                                            |

## Existing production components to retain

`src/modules/session/runtime.ts`, `src/modules/language/translation.ts`,
`src/modules/perception/speech.ts`, `src/adapters/*`, `src/platform/*`,
and the Commander and Ink presentation wiring in `src/bootstrap` and
`src/presentation`. The convergence must not fork these.

## Duplicated orchestration to eliminate

1. The lab owns a second transcript to screen path. The production path
   must be the only path, and the lab must consume it.
2. The lab owns a second translation wiring. The production composition
   root must own it.
3. The lab owns a second terminal application entry point. The production
   entry point must own it.
4. The lab owns a projection of session state. The projection belongs to a
   production module.

## Lab only artifacts to keep isolated

The qualification harness and its ledger, the evaluator and its
normalisation policy, the trace writers, the fixture generator, the WAV
files, the authored scenario, the captured sequence fixture, the reference
transcript, and the counterfactual suites that depend on those fixtures.

## Required production acceptance tests

1. A production transcript event reaches the surface through the production
   composition root, with no lab module imported.
2. A translation follows an accepted transcript event, and a rejected,
   duplicate, or stale event produces no translation request.
3. A translation for an older revision never overwrites a newer one.
4. A translation failure degrades only the translation, and the source
   speech stays visible.
5. Cancellation during outstanding translation work terminates it and
   leaves no orphaned request.
6. The request, input, and output ceilings are enforced before any
   outbound request, with a negative control.
7. No production module imports anything under `lab/`.
8. The production terminal surface keeps the accepted interaction
   contract: comprehension first, original on demand, explicit pending,
   provisional, committed, failed, and superseded states, stable selection,
   no focus theft, no forced mode transition, and no new panel system.

## Smallest path

1. Move the projection into a production module and express it over the
   production session runtime outputs.
2. Move the rendering and input handling into `src/presentation`, keeping
   the accepted layout and interaction contract.
3. Move the event path into `src/modules/session`, so the terminal consumes
   projected state instead of a lab feed.
4. Wire the promoted surface in `src/bootstrap/composition.ts`, and make
   the production path the only path.
5. Repoint the lab suite at the production modules, so the lab keeps
   testing the product path rather than a parallel one.
6. Run the production acceptance tests, then the repository gate, then the
   existing evidence and qualification suites unchanged.

No new framework, event bus, orchestration layer, provider abstraction,
persistence layer, or dependency is implied by this plan.
