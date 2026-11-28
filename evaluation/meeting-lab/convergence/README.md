# Meeting Lab convergence

This is a single offline prototype for design review. The three-concept
[baseline](../README.md) and its [human review protocol](../REVIEW.md#human-review-protocol)
remain frozen at `b80df2d88d2f602e94b09765738d63a42c7a0246`. This
prototype reuses the baseline replay, clock, meeting and screenshot
toolchain. Extra transcript turns, translations and context signals are
authored fixtures. There is no production capture, inference, storage,
or send action.

## Try it

From the convergence worktree with Node 24 and the repository's existing
dependencies available:

```sh
./node_modules/.bin/tsx --tsconfig evaluation/meeting-lab/convergence/tsconfig.json \
  evaluation/meeting-lab/convergence/run.tsx --at 605
```

The normal start is paused at the 03:00 join. Space runs the replay.
`--speed 1` runs the authored clock. `--wide` enables the optional
context panel at 88 columns or more during tasks. Follow uses one pane.
`--comprehension id|en` and `--reply en|id` select roles from the
authored bilingual fixture. The default is Indonesian comprehension
and English suggestions with their Indonesian meaning. English and
Indonesian are the languages available in this fixture. UI chrome is
Indonesian, and caption translations are authored for Indonesian only.

| Action                                     | Keys                                                                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Follow                                     | `Esc` from any view, including while typing                                                                                                                                               |
| Catch Up                                   | `c`, then `e` for cited evidence                                                                                                                                                          |
| Respond                                    | `r` to open or return, `d` reveal, `x` type a local note, Enter finish typing                                                                                                             |
| Review evidence or select another question | `e` opens citations. `←` / `→` browse. `r` returns to the retained draft. `n` in Respond explicitly loads the latest question; this starts a fresh note if the selected question changes. |
| History and delayed translations           | `h` history, `t` delayed translations, `←` / `→` select, `o` original                                                                                                                     |
| Recovery point and scroll                  | `m` marks a visible or selected source as last understood. `↑` / `↓` scroll wrapped body content.                                                                                         |
| Layout and details                         | `w` toggles optional wide view, `i` expands status in place, `?` shows keys                                                                                                               |
| Replay and closure                         | Space play/pause, `.` next event, `]` next chapter, `v` review, `l` learn, `a` answer, `q` quit outside the composer                                                                      |

## Adversarial checkpoints

| Start / sequence                                                           | Expected evidence                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 05:33 → 05:34 (`--at 333`, `.`, `t`)                                       | The late translation for the race discussion attaches to the original source row after it has left the three-turn Follow viewport. The notice opens a bounded list. `o` reveals the original.                                                                                                                              |
| 10:05 (`--at 605`, `r d`), advance to 10:24 and 10:44                      | Ambiguous addressee stays explicit on the selected question. Context changes are visible without changing the selected question or revealing a new draft. The user may select the latest question with `n`.                                                                                                                |
| 10:44 → 11:00 → 11:14 (`--at 644`, `r d x`, type, Enter; advance playback) | Migration failure makes the selected draft stale. Another question follows for Leo. Use `e`, arrows and `r` to examine draft references and new evidence separately. The draft and note are retained. Selecting Leo's new question yields no suggestion.                                                                   |
| 10:05 (`--at 605`, `h r d`)                                                | The latest history line is the overlap about who was asked. This selected utterance has no authored draft.                                                                                                                                                                                                                 |
| 03:03 → 07:25 (mark with `m`, advance, then `c`)                           | At 12 retained utterances the old source falls out. Its timestamp remains marked as last understood, and Catch Up declares the source unavailable. Last viewed identifies the source shown first in Follow or explicitly opened. Recap coverage is independently authored and names its actual span and missing citations. |
| 10:44 at 120×33 (`--wide --at 644`, `r d x`), resize to 44×11              | Notes and the selected question survive. The second pane collapses. In the composer, the typed tail stays visible. After Enter, `↑` / `↓` reveal wrapped content. `Esc` returns to Follow in one action.                                                                                                                   |
| 20:10 (`--at 1210`, open any task)                                         | Gap and translation failure stay above task content. Reconnect retains evidence of missing speech. Show details with `i`.                                                                                                                                                                                                  |
| 30:00 (`--at 1800`, `v` or `l a`)                                          | Authored final handoff and vocabulary task remain available for the baseline review protocol.                                                                                                                                                                                                                              |

## Review evidence

The same **10:05 open-draft checkpoint** is captured at
[58×22](./screenshots/respond-58x22.png),
[86×28](./screenshots/respond-86x28.png), and
[120×33 with wide mode](./screenshots/respond-120x33.png). Those frames
occupy 12, 10, and 13 nonblank rows respectively. The footer is anchored
at the terminal edge. Spare blank rows remain available to display longer
content. The 44×11 frames rely on scrolling or a one-line composer tail.

- **Draft conflict** · [Focused](./screenshots/draft-migration-failed.png) · [Wide](./screenshots/draft-failure-wide.png)
- **Translation and recovery** · [Delayed translation](./screenshots/late-translation.png) · [Evicted recovery point](./screenshots/recovery-point-evicted.png)
- **Short terminal** · [Long draft scrolled](./screenshots/long-draft-short.png) · [Note at compact dimensions](./screenshots/resize-during-input.png)

PNGs are rasterized Ink frames with authored checkpoints. The resize
PNG represents the final compact state. The real terminal exercise tests
the actual resize event and subsequent input. Ink emitted an interim
repaint with clipped wide content before settling into the compact
layout. Language roles in the
fixture are independent of which of the two panes is showing.

## Trade-offs for human evaluation

Test the single-pane default first and offer wide mode as an explicit
alternative. The short recent feed keeps Follow visually quiet. History
and the delayed-translation view give access to older retained speech
at the cost of an explicit action. A dense wide panel increases what
can be seen simultaneously and reduces the width available for the
selected task. The lab retains 12 accessible source rows so participants
can quickly encounter eviction. This capacity is an experiment
parameter. The full source fixture stays in the lab for replay.

In Respond, the selected question and cited evidence stay anchored
while the draft is being read or edited. Changes are separate citations
with a persistent stale-draft warning. The warning is an authored
fixture signal, including the migration failure. It provides no
evidence for real-time correction detection. Retaining the draft makes
it inspectable. The human study should check whether people read the
warning before speaking, whether the selected question stays clear, and
whether the recovery distinctions reduce costly wrong turns.

Keep the original [human review protocol](../REVIEW.md#human-review-protocol)
and add the adversarial sequences above. Record first responses, wrong
turns, source checks and actions to reach Follow. Ask participants
whether a visible translated line was actually understood. The lab
measures availability, layout and key behavior. Comprehension,
cognitive load, and usability remain human questions.

## Verify

The focused tests exercise retained translation notices, corrections on
the selected source row, explicit question changes, draft retention
across evidence inspection, wrong and ambiguous addressees, unavailable
recovery sources, wrapping and scrolling, and warnings across all
views. A separate real pseudo-terminal run resized from 120×33 to
44×11 during typing, removed an entire emoji grapheme, accepted CJK
input, returned to Follow with Esc, and recovered the same note.

```sh
./node_modules/.bin/tsc -p evaluation/meeting-lab/convergence/tsconfig.json
./node_modules/.bin/eslint evaluation/meeting-lab/convergence
./node_modules/.bin/vitest run --config evaluation/meeting-lab/convergence/vitest.config.ts
env -u NO_COLOR FORCE_COLOR=3 ./node_modules/.bin/tsx \
  --tsconfig evaluation/meeting-lab/convergence/tsconfig.json evaluation/meeting-lab/convergence/capture.tsx
```

Convergence is ready for design review. Final production design
approval and Milestone 5 implementation remain on hold.
