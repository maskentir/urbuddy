# Capability matrix and roadmap reconciliation

Date: 2026-11-28. The repository is the canonical source of truth. This
document reconciles the repository state with the canonical nine milestone
roadmap. It does not create a new roadmap.

## Canonical roadmap reconciliation

| #   | Milestone                  | Repository state       | Evidence                                                        |
| --- | -------------------------- | ---------------------- | --------------------------------------------------------------- |
| 1   | Application Foundation     | done, merged           | PR #1, `cd4e350`                                                |
| 2   | Core Runtime               | done, merged           | PR #6 `f7fe1f3`, PR #7 `fe7ad4a`                                |
| 3   | Speech Perception          | done, merged           | PR #8 `9c68558`, PR #10 `96ca747`                               |
| 4   | Live Language Engine       | **in progress**        | PR #11 merged as `ad7ca4a`; semantic acceptance gate still open |
| 5   | Terminal Experience        | experimental candidate | production terminal surface under `OWNER-M5-2026-11-28`         |
| 6   | Communication Intelligence | planned                | not started                                                     |
| 7   | Personal Memory            | planned                | not started                                                     |
| 8   | Adaptive Learning          | planned                | not started                                                     |
| 9   | Production Qualification   | planned                | partial evidence only                                           |

The roadmap file no longer says that PR #11 awaits review. It was merged as
`ad7ca4a`.

## Capability matrix

The states are distinct and must not be conflated.

| Capability                                                               | Production source    | Merged      | Lab only | Verified locally           | Verified against a real provider                | Semantically qualified                        | Human validated                    | Planned                |
| ------------------------------------------------------------------------ | -------------------- | ----------- | -------- | -------------------------- | ----------------------------------------------- | --------------------------------------------- | ---------------------------------- | ---------------------- |
| Typed errors, lifecycle, configuration, CLI, terminal smoke              | yes                  | yes, PR #1  | no       | yes                        | no                                              | no                                            | no                                 | no                     |
| Session runtime, replay, ordering, gaps, duplicates, stale, cancellation | yes                  | yes, PR #6  | no       | yes                        | no                                              | no                                            | no                                 | no                     |
| Durable evidence persistence and transactional outbox                    | yes                  | yes, PR #7  | no       | yes                        | no                                              | no                                            | no                                 | no                     |
| Native macOS audio acquisition                                           | yes                  | yes, PR #8  | no       | yes                        | yes, synthetic frames                           | no                                            | no                                 | no                     |
| Muse streaming speech recognition                                        | yes                  | yes, PR #10 | no       | yes                        | **yes**, two owner-authorized live runs         | no                                            | no                                 | no                     |
| LangChain translation adapter and model gateway                          | yes                  | yes, PR #11 | no       | yes                        | **yes**, 46 provider invocations on 27 November | **no**, neither model met the frozen criteria | no                                 | no                     |
| Revision-aware translation scheduler                                     | yes                  | yes, PR #11 | no       | yes                        | yes, through the same adapter                   | no                                            | no                                 | no                     |
| Indonesian glossary in the translation prompt                            | yes                  | yes, PR #11 | no       | yes                        | yes                                             | no                                            | no                                 | no                     |
| SQLite evidence store and outbox                                         | yes                  | yes, PR #7  | no       | yes                        | no                                              | no                                            | no                                 | no                     |
| Terminal presentation and Commander CLI                                  | yes                  | yes, PR #1  | no       | yes                        | no                                              | no                                            | no                                 | no                     |
| Event-driven terminal state through shared session admission             | yes, draft candidate | no          | no       | synthetic and loopback     | no                                              | no                                            | no                                 | Milestone 5            |
| Admission and translation publication through the existing scheduler     | yes, draft candidate | no          | no       | synthetic and loopback     | no                                              | no                                            | no                                 | Milestone 5            |
| Muse qualification harness, ledger, evaluator, preflight                 | no                   | no          | **yes**  | yes                        | yes, for the two paid attempts                  | no                                            | no                                 | no                     |
| Frozen semantic corpus and model comparison                              | no                   | no          | **yes**  | yes                        | yes, 46 invocations                             | no                                            | **no**, bilingual sign-off pending | no                     |
| Adaptive Single Flow surface as the terminal experience                  | yes, draft candidate | no          | no       | synthetic PTY and loopback | no                                              | no                                            | no                                 | Milestone 5            |
| Communication assistance, response drafting, memory, learning            | no                   | no          | no       | no                         | no                                              | no                                            | no                                 | yes, Milestones 6 to 8 |
| Production qualification gates                                           | no                   | no          | no       | partial                    | partial                                         | no                                            | no                                 | yes, Milestone 9       |

## Pull request state

| PR  | Title                                                               | Base   | State             | Branch                              |
| --- | ------------------------------------------------------------------- | ------ | ----------------- | ----------------------------------- |
| #1  | establish application foundation                                    | master | merged, `cd4e350` | `feat/application-foundation`       |
| #6  | establish executable session runtime                                | master | merged, `f7fe1f3` | `feat/core-runtime`                 |
| #7  | establish durable evidence persistence                              | master | merged, `fe7ad4a` | `feat/durable-persistence`          |
| #8  | establish native macOS audio acquisition                            | master | merged, `9c68558` | `feat/native-audio-capture`         |
| #10 | establish streaming speech recognition                              | master | merged, `96ca747` | `feat/streaming-speech-recognition` |
| #11 | establish live language engine                                      | master | merged, `ad7ca4a` | `feat/live-language-engine`         |
| #12 | event-driven runtime integration and Muse qualification path        | master | merged, `88c166a` | `feat/muse-stt-qualification`       |
| #13 | contextual comprehension through the existing translation scheduler | master | merged, `ef5e212` | `feat/contextual-comprehension`     |

## Milestone 4 state after the PR #12 merge

| Item                       | Value                                             |
| -------------------------- | ------------------------------------------------- |
| Master before              | `ad7ca4a43424315f23292dc0fd96e27d9cc1d437`        |
| Master after               | `88c166a108fc70e41bbfc3081239c4be7eb893ea`        |
| Merged revision reviewed   | `9d52584d2d163304474eccddf3e83f6cf4e0c0a2`        |
| Tree equivalence           | the merged tree is identical to the reviewed tree |
| Reachable binary artifacts | none                                              |
| Milestone 4 semantic gate  | **open**                                          |

## What is not claimed

- No provider model is semantically qualified. The 27 November comparison
  records 20 of 21 semantic cases for Terra and 17 of 21 for Luna, and
  **neither** met the frozen criteria.
- No human bilingual adjudication exists.
- Milestone 5 candidate evidence is limited to synthetic data and loopback.
  Real-provider latency, sustained human usability, and semantic acceptance
  remain open.
- The qualification harness, its ledger, its evaluator, and its fixture
  audio are lab artifacts and must not become production dependencies.
