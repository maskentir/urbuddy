# Canonical roadmap

Capability milestones in dependency order. Each milestone ships a
product capability with an acceptance gate; reliability, security, and
observability are built into every integration, not deferred to the
end. Milestone names describe capabilities, not internal phases.

Status values: `done`, `next`, `planned`.

## 1. Application Foundation — done

Product outcome: a coherent engineering platform (kernel, contracts,
toolkit, toolchain, governance) that makes each subsequent milestone
faster and safer without becoming a framework of its own.

Dependencies: none (greenfield).

Scope: typed errors, identities, lifecycle, configuration, security
policy, CLI, terminal smoke path, architecture enforcement,
deterministic tests, contributor conventions.

Non-goals: speech recognition, translation, memory, learning.

Acceptance gate: reviewed foundation merged. Met by
[PR #1](https://github.com/maskentir/urbuddy/pull/1), squash-merged as
`cd4e350`.

## 2. Core Runtime — done

Product outcome: an executable offline session replay that proves the
runtime's streaming semantics before any live provider is involved,
followed by durable persistence for session evidence.

Dependencies: Application Foundation.

Scope: session lifecycle, streaming contracts, deterministic replay,
ordering, bounded processing, backpressure, cancellation.

Non-goals: live audio capture, provider integration, translation.

Acceptance gates, in order, each through a separate implementation
PR:

1. Executable offline session replay with recorded ordering, gap
   accounting, and cancellation behavior. This first replay PR is
   not expanded with persistence work. Met by
   [PR #6](https://github.com/maskentir/urbuddy/pull/6).
2. Durable persistence: SQLite evidence durability (per-database WAL
   and synchronous policy, commit acknowledgement, crash recovery)
   and transactional outbox semantics (enqueue, claim, retry without
   loss or duplication). Met by
   [PR #7](https://github.com/maskentir/urbuddy/pull/7).

## 3. Speech Perception — next

Product outcome: real-time English transcription of live meetings,
including accented and fast speech, with reconnect and gap accounting.

Dependencies: Core Runtime.

Scope: native macOS audio acquisition, streaming STT integration,
technical vocabulary handling, reconnect and gap accounting.

Non-goals: translation, meeting recording for its own sake.

Acceptance gates, in order, each through a separate implementation
PR:

1. Native macOS audio acquisition with explicit continuity and
   lifecycle semantics. Met by
   [PR #8](https://github.com/maskentir/urbuddy/pull/8).
2. Streaming speech recognition: real-time English transcription
   within the latency and loss budgets defined in
   [architecture](./architecture.md). Implemented against a local
   protocol server; live provider acceptance remains pending
   owner-authorized execution.

## 4. Live Language Engine — planned

Product outcome: reliable English–Indonesian translation that stays
readable while speech is still in flight.

Dependencies: Speech Perception, Core Runtime.

Scope: contextual translation, semantic units, provisional and
committed outputs, revision control, glossary handling.

Non-goals: general-purpose chat, summarization.

Acceptance gate: committed translations preserve negation, numbers,
commitments, and technical terms on the mandatory regression corpus
with zero critical semantic errors.

## 5. Terminal Experience — planned

Product outcome: a usable real-time meeting assistant in the
terminal: live captions, comprehension help, session controls, and
honest degradation indicators.

Dependencies: Live Language Engine.

Scope: bilingual streaming panels, keyboard navigation, history,
session diagnostics.

Non-goals: a web dashboard, mobile clients.

Acceptance gate: a full meeting can be followed, reviewed, and
diagnosed from the terminal alone.

## 6. Communication Intelligence — planned

Product outcome: practical help responding in meetings: reply
assistance, technical explanations, missed-context recovery.

Dependencies: Terminal Experience, Live Language Engine.

Scope: catch-up over session evidence, contextual explanations,
response drafting the user approves before sending.

Non-goals: autonomous participation, auto-sent messages.

Acceptance gate: assistance is always grounded in session evidence
and never acts without user approval.

## 7. Personal Memory — planned

Product outcome: context continuity across sessions from durable,
user-authorized evidence and personal vocabulary knowledge.

Dependencies: Core Runtime persistence, Speech Perception.

Scope: authorized durable evidence, contextual retrieval, personal
vocabulary tracking, deletion propagation.

Non-goals: cloud-synced knowledge, shared team memory.

Acceptance gate: deletion of a source removes or reconciles all
derived knowledge from it; indexes rebuild from authorized sources.

## 8. Adaptive Learning — planned

Product outcome: personalized learning generated from real
conversations, scheduled for retention.

Dependencies: Personal Memory, Live Language Engine.

Scope: difficulty modeling from observed (not inferred) performance,
contextual exercises, FSRS scheduling, measured progression.

Non-goals: generic courses, CEFR certification, passive-exposure
mastery claims.

Acceptance gate: reported progress reflects measured unaided
comprehension, not exposure time.

## 9. Production Qualification — planned

Product outcome: evidence-backed production readiness across the
integrated system.

Dependencies: all of the above.

Scope: reliability, privacy, latency, resource consumption, endurance,
and distribution evidence; reproducible packaging and upgrades.

Non-goals: SaaS operations, fleet management.

Acceptance gate: every mandatory release gate in
[architecture](./architecture.md) is measured green; aspirational
performance targets may remain open only with an owner and a plan.
