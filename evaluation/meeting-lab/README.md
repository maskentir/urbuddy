# Meeting Stress Simulation

An offline, disposable design lab based on master
`ad7ca4a43424315f23292dc0fd96e27d9cc1d437`. The same fixture drives
Companion, Adaptive Workspace, and Attention-Aware Companion. Design
review is the gate before choosing an interaction model or starting
Milestone 5.

## Try a concept

Run from the lab worktree with Node 24 and the repository's existing
dependencies available. In this worktree the dependency directory is
linked to the main checkout. Run the local executable directly.

```sh
./node_modules/.bin/tsx --tsconfig evaluation/meeting-lab/tsconfig.json \
  evaluation/meeting-lab/run.tsx --concept attention
```

Substitute `companion` or `workspace`. The replay starts paused just as
you join at 03:00. Press Space to run. The default 12× pace compresses
the remaining 27 scenario minutes into 2m15s. Set `--speed 1` for the
authored time scale, `--play` to start running immediately, or
`--at 605` to rehearse the unexpected question. Use a new process for
each concept so that all three start with the same state.

| Key              | Action                                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| `f`, `c`, `r`    | Follow, Catch Up, Respond                                                 |
| `h`, arrows, `p` | Open history, browse captured utterances, toggle a temporary pin          |
| `m`              | Mark a Conversation Recovery Point                                        |
| `d`, `e`         | Reveal the simulated draft, open or cycle through cited source utterances |
| `v`, `l`, `a`    | Review, Learn, reveal answer                                              |
| `i`, `?`, `q`    | Privacy and status, keys, quit                                            |
| Space, `.`, `n`  | Play/pause, step to next event, advance to next chapter                   |

A recovery point also records the first departure from Follow into
history, Catch Up, or Respond. It records time, so a later pause or
navigation action leaves it in place. Press `m` to set a new point.
History selection stays on the chosen utterance while playback advances.

## The Friday Release Crisis

| Time        | Chapter              | Pressure on the participant                                                                                                        |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 00:00–03:00 | Late arrival         | Opening speech is unavailable through the viewer. An explicitly simulated moderator note is available at join.                     |
| 03:00–07:00 | Technical discussion | Distinguish the checkout race, idempotency key, migration, and flag rollback.                                                      |
| 07:00–10:00 | Heated disagreement  | Overlap, changing source partials, a staging-only correction, and a wrong-revision translation.                                    |
| 10:00–13:00 | Unexpected question  | An overlapping exchange obscures who the CTO asked. Address is clarified at 10:24.                                                 |
| 13:00–17:00 | Translation overload | Rapid turns, a revised pilot scope, dropped stale Indonesian output, and replay backlog rising to nine.                            |
| 17:00–20:00 | Missing context      | Screen, PR 483, and a prior decision note are referenced but unavailable.                                                          |
| 20:00–24:00 | Service degradation  | Translation failure, two capture gaps, reconnects, and an uncertain speaker label.                                                 |
| 24:00–28:00 | Decision reversal    | Friday becomes a conditional Monday pilot, responsibility moves to Sari, and an append-only correction moves the partner deadline. |
| 28:00–30:00 | Meeting closure      | Review the latest commitments and attempt a vocabulary exercise after close.                                                       |

Play as Sari, a backend engineer who joined late. The other participants
are CTO Rina, release owner Mira, backend engineer Dimas, and on-call
SRE Leo. The fixture declares Indonesian, US, and UK English accent
backgrounds and includes Indonesian and code-switched lines. It is an
authored 30-minute timeline with excerpted speech and a tightly paced
burst. Accent, speech tempo, and overlap are scenario cues in the text
replay. Acoustic intelligibility and the effect of concurrent audio
require a separate human exercise.

[Deterministic fixture](./scenario.ts) · [Comparative review and coverage matrix](./REVIEW.md)

## Event boundaries

- **Existing contract categories, synthetic samples.** Source partials
  and finals, source revision, capture discontinuities, committed
  translation and degradation correspond to current transcript and
  translation contracts. The lab projects these into a small fixture
  type and uses authored arrival times and results. It opens no capture
  source, provider connection, or persistence layer.
- **Fixture annotations.** Accent, overlap, changed speaker confidence,
  exact per-tick queue depth, and cross-utterance supersession are
  authored stress signals. Runtime equivalents and accuracy are
  unverified. The wrong-revision and superseded translation arrivals
  are deliberately injected counterexamples. The lab checks lineage
  before rendering them.
- **Interaction hypotheses.** Recovery points, catch-up notes, response
  drafts, final handoff and vocabulary checks are lab behavior.
  Authored future-content cards say SIMULATED and cite available
  transcript evidence when possible. Missing screen, PR, and gap
  content stay unavailable. Pins are session-local in memory. Drafts
  are shown for the participant to read and there is no send action.
- **Future runtime work.** Grounded recap and response generation,
  correction detection across finalized utterances, reliable speaker
  attribution, contextual memory and adaptive learning are outside
  this lab. The fixture establishes no production throughput or
  translation quality.

## Reproduce evidence

```sh
./node_modules/.bin/tsc -p evaluation/meeting-lab/tsconfig.json
./node_modules/.bin/eslint evaluation/meeting-lab
./node_modules/.bin/vitest run --config evaluation/meeting-lab/vitest.config.ts
env -u NO_COLOR FORCE_COLOR=3 ./node_modules/.bin/tsx \
  --tsconfig evaluation/meeting-lab/tsconfig.json evaluation/meeting-lab/capture.tsx
```

The last command uses the installed macOS Swift toolchain to rasterize
actual Ink-rendered frames at fixed terminal grid sizes. The PNGs are
terminal-frame captures. Colors, typography, and wrapping can differ
in a participant's terminal.
