# Meeting lab review

**Advance Attention-Aware Companion to human comparison as the leading
hypothesis.** Use Companion as the low-distraction control and test
Adaptive Workspace for wide-terminal operators. Keep the final
interaction design open until co-founder and owner review.

The reason to test Attention-Aware first is the combination of a shorter
Follow feed, an explicit recovery point, and a single current-source
line while drafting. Companion uses the fewest visible rows and has
the simplest visual hierarchy. Its task screens replace the transcript.
Adaptive Workspace retains a fuller transcript while showing a task
panel at 86 and 120 columns. That makes simultaneous reference possible,
with narrower reading columns. At 58 columns it stacks and the
concurrent-reference advantage disappears. The two alternatives probe
whether retaining more context helps or competes for attention.
The compact Attention-Aware response fills all 22 rows, so it has
no spare vertical margin at that checkpoint.

## Controls for the comparison

The fixture, timings, source text, simulated cards, source links, and
bindings are identical. The independent variable is information
placement and how much live transcript stays visible during each task.
All timings below are replay timestamps. Scripted routes count key
presses, excluding playback controls. They give lower bounds with the
bindings already known. Discoverability and response readiness in
practice remain human measurements.

| Task                                                  | Route     | Key presses per concept |
| ----------------------------------------------------- | --------- | ----------------------: |
| Open Catch Up from Follow                             | `c`       |                       1 |
| Set recovery point, open Catch Up, return live        | `m c f`   |                       3 |
| Find and reveal a response draft                      | `r d`     |                       2 |
| Open draft and inspect its first two citations        | `r d e e` |                       4 |
| Open history, move one utterance back, pin and return | `h ↑ p f` |                       4 |
| Inspect capture, egress and retention disclosures     | `i`       |                       1 |
| Open closure handoff                                  | `v`       |                       1 |
| Open vocabulary task and reveal answer                | `l a`     |                       2 |

At 10:05 with the same draft open, actual Ink frames used the following
number of occupied rows, including headers and key hints. Row count is
layout evidence. Reading comfort, load and comprehension require a
participant.

| Concept                   | Compact 58×22 | Standard 86×28 | Wide 120×33 |
| ------------------------- | ------------: | -------------: | ----------: |
| Companion                 |            18 |             17 |          17 |
| Adaptive Workspace        |            19 |             22 |          20 |
| Attention-Aware Companion |            22 |             21 |          21 |

The [screenshots](./screenshots/) include all nine frames. Compare
[Companion](./screenshots/companion-86x28-respond.png),
[Adaptive Workspace](./screenshots/workspace-86x28-respond.png), and
[Attention-Aware Companion](./screenshots/attention-86x28-respond.png)
at the same 86×28 checkpoint.

## Scenario-to-interaction coverage

| Scenario and review task                                          | Companion                                              | Adaptive Workspace                                   | Attention-Aware                                                    | Evidence or correctness boundary                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Late arrival · explain why checkout is under review               | `c` replaces captions with the join note.              | Note sits by live captions on standard/wide.         | Catch Up shows the recovery point and note.                        | [Join capture](./screenshots/late-arrival.png). Opening transcript inaccessible.                                                                        |
| Technical discussion · explain the race and what rollback changes | Follow original and available ID. `h` opens full line. | Live column remains while browsing at standard/wide. | Shorter recent feed. History opens earlier turns.                  | Two workers may both charge. Same key must reuse result. Flag rollback retains constraint. Accents are fixture metadata.                                |
| Heated disagreement · identify what actually ran                  | Original revision visible in Follow.                   | Follow plus contextual panel if opened.              | Current source and corrections first.                              | Revision 2 limits migration to staging. Delayed revision 0 is rejected. An uncertain label stays uncertain.                                             |
| Unexpected question · decide whether to ask for clarification     | `r d` fills the single task view.                      | Draft beside continuing transcript on standard/wide. | Draft leads, with one current-source line below.                   | 10:05 card suggests a clarification. 10:24 clarification requires explicit reveal of the new draft.                                                     |
| Translation overload · stay oriented and return from history      | Backlog visible globally. `h` selection stays stable.  | History with live column on standard/wide.           | Scoped recent feed and anchored Catch Up.                          | [Overload capture](./screenshots/overload.png). Backlog peaks at nine. Source rows keep arriving. Pilot only survives the late broad translation.       |
| Missing context · say what evidence is unavailable                | `c e` opens spoken citation.                           | See citation with live transcript at standard/wide.  | Catch Up leads with uncertainty.                                   | PR 483 is a spoken reference. Screen, diff, and prior note remain unavailable.                                                                          |
| Service degradation · identify loss and privacy state             | Global gap and failure text, `i` for details.          | Same text; status can sit beside transcript.         | Status shows both intervals and preserves attribution uncertainty. | [Outage capture](./screenshots/gap.png). Observer loses 56 s and 13 s. Reconnect preserves the gap.                                                     |
| Reversal · give current date, owner, deadline and condition       | `c e` opens current cited decision.                    | Compare current source with the panel or old pin.    | Catch Up summarizes changes relative to the mark.                  | [Reversal capture](./screenshots/reversal.png). Old Friday row is marked superseded. A late translation cannot restore it. Noon means Monday, after go. |
| Closure · review commitments and retrieve a word meaning          | `v` handoff, `l a` exercise.                           | Review beside transcript on standard/wide.           | Focused handoff and exercise, same source links.                   | [Closure capture](./screenshots/closure.png). Views unlock at 30:00. Pins are transient.                                                                |

## Engineering walkthrough

The focused suite checks Follow at every scripted event plus task
checkpoints across all nine concept/size combinations. Real Ink input
tests cover draft and source navigation, live history, and closure.
A separate pseudo-terminal walkthrough completed the full timed
scenario at 60× on Companion (58×22), Workspace (86×28), and
Attention-Aware (120×33). Each opened Catch Up, browsed history during
playback, observed the outage, and opened closure review and learning.
This was a functional walkthrough by the implementation agent.

## Human review protocol

Invite co-founders and target users who regularly join multilingual
technical meetings. Use the same terminal size and replay speed
within a comparison. Rotate the concept order across participants
and record it. Have the first concept run uncoached. The reused
scenario creates a learning effect, so treat first-run answers and
later comparative observations separately. For this round use
scripted text as the task stimulus and reserve acoustic testing for a
follow-up with consented or synthetic audio.

1. Start at 03:00. Ask what was lost and why checkout is under review.
   Later ask what the retry guarantee is and whether production was
   migrated. Record answer accuracy against the scenario and source
   references used.
2. At 10:05, ask the participant to prepare a reply. Record time to a
   speakable answer, keys, and whether the person noticed uncertain
   address. At 10:24, check whether the revised answer follows the
   clarified request and still waits for the staging result.
3. During the burst, ask the participant to find an earlier caption
   while replay keeps advancing. On return, ask for the pilot scope
   and whether translation is behind. Compare what was missed and
   time to reorient.
4. During the gap and after reconnect, ask what was lost, whether an
   attribution can be trusted, and what is captured, sent, and saved.
   Record spontaneous detection before prompting and completeness
   after prompting.
5. At closure, ask for the schedule, scope, condition, owners and
   deadline. The evidence is Monday 10:00 WIB, pilot only after the
   two-worker staging pass. Sari owns go/no-go and deployment. Dimas
   owes results and rollback plan at 09:00 WIB. Mira owes the partner
   note by Monday noon after go. Leo monitors duplicate charges.
   Screen and PR are unresolved. Ask what “idempotent” should mean
   for a retried checkout before revealing the answer.

For **cognitive load**, ask the participant to rate mental effort
from 1 to 7 after each task and describe what competed for attention.
For **readability**, record overlooked or misread lines after repeating
selected tasks at 58×22 and 120×33. For **interaction cost**, count actual
keys, including wrong turns, and compare to the scripted routes. For
**semantic integrity**, log any stale date, owner, or confident claim
from a gap. For **comprehension and recovery**, score propositions
separately and note the evidence path. Use open-ended questions before
showing the answers. Compare **failure and privacy awareness** against
the current status and the offline disclosure.

A material stale decision treated as current, a hidden coverage gap,
or a mistaken belief that sensitive data was sent is a design
failure requiring review. Use human task observations across the three
layouts to choose the interaction model. This walkthrough and the
automated evidence establish feasibility. Human comprehension,
cognitive load, and usability remain unmeasured.
