# System architecture

Urbuddy is a real-time language intelligence runtime with the terminal
as one consumer of that runtime. The data plane (capture, streaming,
translation, persistence) operates independently of the intelligence,
memory, and learning planes. If Graphiti, the LLM, or the learner is
down, STT captions keep working. If the translation provider fails,
the original transcription remains available but translated output is
not guaranteed.

## Logical structure

```text
capture (Swift helper / IPC)
  -> perception (streaming STT adapter, diarization, continuity)
    -> language (segmentation, provisional + committed translation)
      -> presentation (Ink TUI, commander CLI)
      -> persistence (SQLite evidence journal, transactional outbox)
  -> intelligence (LangChain/LangGraph supervisory workflows, off hot path)
    -> memory (Graphiti sidecar, derived and rebuildable)
      -> learning (FSRS scheduler, learner profile)
```

Data flows downward; failures are contained per engine. No engine may
overwrite original evidence with derived artifacts.

## Technology baseline

Status values: `selected` (direction locked, not yet proven),
`implemented` (in tree), `verified` (executed evidence),
`qualified` (production gate passed).

| Area                   | Selection                                                                              | Status                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Runtime                | Node.js 24, strict TypeScript, pnpm, NodeNext ESM                                      | implemented, verified                                                                                  |
| Cancellation lifecycle | `AbortSignal`, `ResourceScope`, bounded disposal                                       | implemented, verified                                                                                  |
| Streaming pipeline     | Native streams, async iterables, backpressure                                          | selected                                                                                               |
| Audio capture          | Swift macOS Core Audio Tap; ScreenCaptureKit only as explicitly authorized alternative | implemented (framed IPC transport, continuity accounting, live 440 Hz playback verified — see ADR-005) |
| Primary STT            | Muse                                                                                   | implemented (Muse adapter, deterministic local-server evidence); live qualification pending            |
| Secondary STT          | Soniox as an explicitly selected mode, never a silent fallback                         | selected                                                                                               |
| Language intelligence  | LangChain.js model gateway                                                             | selected                                                                                               |
| Contextual reasoning   | GPT-family model; exact callable model ID must be validated before use                 | selected                                                                                               |
| Stateful orchestration | LangGraph.js, supervisory only, outside the real-time hot path                         | selected                                                                                               |
| Persistence            | SQLite WAL, better-sqlite3, Drizzle, transactional outbox (FTS5 deferred)              | implemented (replay evidence), verified                                                                |
| Durable processing     | SQLite transactional outbox, not a distributed queue                                   | implemented, verified                                                                                  |
| Personal memory graph  | Graphiti + embedded FalkorDB Lite, derived and rebuildable                             | selected                                                                                               |
| Learning               | ts-fsrs                                                                                | selected                                                                                               |
| Interface              | Ink, React, Commander                                                                  | implemented, verified                                                                                  |
| Evaluation             | DeepEval, COMET, chrF, human-calibrated references                                     | selected                                                                                               |
| Observability          | Pino, local OpenTelemetry, no remote exporters by default                              | implemented (Pino), selected (OTel)                                                                    |
| Quality toolchain      | TypeScript, ESLint, Prettier, dependency-cruiser, Knip, Vitest                         | implemented, verified                                                                                  |

Selected is not qualified. No technology counts as production-ready
because it appears in this table; qualification requires executed
evidence under the production failure model.

## Ownership boundaries

Enforced by dependency-cruiser; `src/adapters` is reserved for vendor
integrations wired only by the composition root.

- `bootstrap`: composition root and process lifecycle. Owns wiring.
- `kernel`: minimal primitives and contracts. Imports nothing above.
- `modules`: domain logic and owned ports. Never imports platform,
  presentation, or bootstrap internals.
- `platform`: infrastructure implementations. Never imports domain or UI.
- `presentation`: CLI and terminal UI. Wired only by bootstrap.
- `adapters`: vendor API translation into kernel contracts.

Adapters and infrastructure may implement public application-owned
ports; domain and application logic must remain independent of
infrastructure implementations. The current dependency-cruiser rules
are foundation constraints: they will be refined when concrete ports
appear, not treated as a mandate to move every contract into kernel.

No `utils`, `helpers`, or `common` catch-alls. Public entry points
expose intentional contracts through explicit named exports.

## Architectural invariants

- The real-time data plane stays independent of optional
  intelligence, memory, and learning subsystems. STT captions survive
  their failure; translation output additionally requires a working
  translation provider.
- Deterministic execution owns correctness; LLM supervision is
  advisory.
- Provisional preview is always separable from committed output.
- Provider finality, translation finality, and durable persistence
  are distinct states; durability is acknowledged only after commit.
- Occurrence identity, operation identity, and content identity are
  distinct.
- Stale revisions never overwrite newer output.
- Data gaps and uncertain outcomes are reported, never concealed.
- SQLite is the authoritative durable store; graph-derived
  information is rebuildable from authorized sources.
- Queues, caches, and concurrency are bounded with explicit
  backpressure, deadlines, and cancellation.
- Application, session, stream, and operation lifetimes are
  independent; shutdown orchestration stays separate from disposal.
- `ResourceScope` is frozen under its approved production-consumer
  gate (see `docs/decisions/003-resourcescope-retention.md`).
- Native primitives and demonstrated abstractions win over
  speculative frameworks.

## Privacy and reliability posture

Local-first does not make cloud inference private. Default-deny
authorization, explicit provider selection, least-privilege egress,
safe logging, credential isolation, and documented retention apply to
every milestone.

Raw audio is ephemeral by default. Proposed retention defaults,
requiring explicit owner approval before use:

- Opt-in transcript persistence: 30 days, configurable.
- Opt-in redacted diagnostics: 7 days.
- Derived data follows source retention and deletion.

No private audio, transcripts, telemetry, or credentials leave the
device without authorization. Uncertain privacy, licensing, security,
and durability guarantees fail closed and are recorded as unverified.

## Service-level objectives (proposed, unmeasured)

Production Qualification cannot pass with an unresolved mandatory
gate. Performance targets are aspirational benchmarks, not release
criteria, until measured on target hardware.

### Mandatory release gates

| Objective                                                   | Required |
| ----------------------------------------------------------- | -------- |
| Acknowledged transcript loss under the failure model        | 0        |
| Silent audio gaps (every detected gap is recorded)          | 0        |
| Stale revision overwrites                                   | 0        |
| Critical semantic errors on the mandatory regression corpus | 0        |
| Unauthorized data egress                                    | 0        |

### Aspirational performance targets

| Objective                                                | Draft target |
| -------------------------------------------------------- | ------------ |
| Audio to first useful translation, p95                   | <= 1.5 s     |
| Final contextual translation, p95 from semantic-unit end | <= 2.5 s     |
| Continuous session endurance incl. provider rotation     | 8 h          |
| Idle memory growth                                       | bounded      |

## Evidence status and gaps

The implementation in this tree carries executed evidence: typecheck,
lint, 77 deterministic tests, architecture enforcement, clean build,
and compiled smoke paths (see [PR #1](https://github.com/maskentir/urbuddy/pull/1)).

The earlier R01–R10 architecture research reports, benchmark runs,
and qualification reports are not present in this repository. Their
conclusions survive here only where restated as selections above, and
every selection above remains `selected`, not qualified, until
reproduced under the production failure model. Research gaps must be
closed by executable experiments, not by re-citing absent documents.
Synthetic replay evidence must never be represented as live-provider
qualification.
