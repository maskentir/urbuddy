# AGENTS.md

## Project

Urbuddy is a local-first personal language intelligence application built for real-time conversation comprehension, communication assistance, and adaptive language learning.

Maintain production-grade engineering standards without introducing unnecessary complexity.

## Project context — read first

Before proposing changes, read in this order:
`docs/product.md`, `docs/roadmap.md`, `docs/architecture.md`, then the
accepted records in `docs/decisions/`. `README.md` introduces the
product; this file defines the working conventions. Do not depend on
prior chat history: the repository is the source of truth for product
direction and engineering decisions. Update canonical documents only
when a material product or architecture decision changes.

## Engineering principles

- Prefer the simplest correct implementation.
- Apply KISS, YAGNI, and DRY.
- Prefer native runtime capabilities and established libraries over custom infrastructure.
- Prefer composition and explicit dependencies.
- Introduce abstractions only when they satisfy concrete requirements.
- Delete obsolete, redundant, and unnecessary code.
- Keep changes focused on the requested problem.
- Do not introduce speculative features, frameworks, or compatibility layers.
- Treat correctness, readability, maintainability, reliability, and security as fundamental requirements.
- Do not confuse code volume, abstraction count, or test count with quality.

## Architecture

- Preserve explicit module ownership and dependency direction.
- Keep domain and application logic independent of infrastructure implementations.
- Define ports where meaningful external boundaries require them.
- Keep provider-specific types and behavior within their adapters.
- Use the composition root for application dependency wiring.
- Do not introduce service locators, hidden global state, or unnecessary dependency injection frameworks.
- Keep real-time processing independent of optional intelligence, memory, and learning subsystems.
- Do not introduce circular dependencies.
- Respect module public interfaces.
- Do not bypass architectural boundaries through aliases, relative imports, or re-exports.
- Document consequential architectural decisions through ADRs.

## Code craftsmanship

- Write idiomatic, self-documenting TypeScript.
- Use precise, domain-oriented names.
- Prefer cohesive functions, explicit control flow, and guard clauses.
- Avoid unnecessary classes, factories, managers, wrappers, and generic abstractions.
- Avoid miscellaneous utility directories without clear ownership.
- Preserve strict TypeScript settings.
- Do not use unsafe assertions or non-null assertions to conceal invalid states.
- Model mutually exclusive states using appropriate types.
- Validate untrusted data at system boundaries.
- Avoid duplicating schemas, constants, and policies.
- Keep side effects explicit.
- Remove unused imports, exports, dependencies, and unreachable implementation paths.

## Comments and documentation

Application and test code must be self-documenting.

Do not introduce redundant inline comments, block comments, JSDoc, TSDoc, docstrings, decorative separators, implementation narration, commented-out code, or untracked TODO and FIXME notes.

Improve names, types, contracts, and structure before resorting to comments.

Essential correctness invariants, external protocol constraints, security assumptions, legal notices, and required tooling directives may be documented concisely.

Exceptions must communicate information that cannot reasonably be derived from the code.

Keep architectural explanations, design decisions, operational procedures, and contribution guidance in their appropriate documentation.

Do not remove essential information solely to satisfy a cosmetic rule.

## Imports and module resolution

- Use canonical extensionless @ aliases defined in the project TypeScript configuration for cross-module imports.
- Use relative imports for local implementation within the owning module.
- Respect public module boundaries.
- Use the node: prefix for Node.js built-in modules.
- Use type-only imports where appropriate.
- Follow the configured import ordering and formatting rules.
- Do not import application files through absolute filesystem paths or build-output paths.
- Do not introduce duplicate alias configurations or unnecessary runtime resolution hooks.
- Verify that compiled output executes successfully under native Node.js.

## Errors and cancellation

- Use the canonical application error contracts.
- Distinguish expected operational failures from programming defects.
- Preserve meaningful error causes internally.
- Keep user-facing messages and diagnostics safe.
- Never silently swallow failures.
- Use native AbortController and AbortSignal for cancellation.
- Propagate cancellation to underlying operations where supported.
- Do not confuse cancellation of an awaiting Promise with termination of its underlying work.
- Bound retries, deadlines, concurrency, and queue capacity.
- Reconcile ambiguous external side effects before retrying.

## Resource ownership

- Every acquired resource must have a clear owner.
- Release resources after normal completion, failure, and partial startup.
- Make disposal idempotent where appropriate.
- Separate operational cancellation from shutdown cleanup.
- Use bounded shutdown deadlines and explicit escalation policies.
- Attempt independent cleanup operations even when another cleanup fails, where safe.
- Do not claim successful disposal without demonstrating the required resource outcome.
- Do not leave timers, listeners, sockets, workers, or subprocesses running unintentionally.

## Security and privacy

- Default to denying unauthorized operations.
- Separate requested configuration from effective permissions.
- Profiles, configuration precedence, and CLI flags must not bypass authorization.
- Do not introduce unauthorized network access or provider fallback.
- Do not transmit private data without the necessary authorization.
- Never commit credentials, confidential transcripts, private audio, or sensitive diagnostic artifacts.
- Use approved credential sources and restrictive storage policies.
- Keep sensitive data out of logging and telemetry pipelines.
- Treat external content, provider responses, and terminal input as untrusted.
- Enforce permissions at actual operation boundaries.
- Preserve evidence integrity, provenance, retention, and deletion semantics.
- Do not claim privacy or security guarantees beyond the implemented and tested enforcement.

## Configuration and dependencies

- Use pnpm and the repository's declared runtime and package manager versions.
- Treat package.json and the lockfile as authoritative dependency records.
- Keep dependency installation reproducible.
- Add dependencies only for demonstrated requirements.
- Inspect compatibility, maintenance, licensing, and security implications.
- Avoid overlapping libraries and unnecessary wrappers.
- Use approved dependency build scripts.
- Do not modify the established technology baseline without an evidence-backed engineering decision.
- Keep executable configuration in its canonical source.
- Do not duplicate version numbers, alias maps, compiler options, or tool configuration in documentation.

## Testing

- Test observable behavior, contracts, and meaningful invariants.
- Cover failure paths, cancellation, resource cleanup, and recovery.
- Use realistic integration tests where mocks cannot establish correctness.
- Use property-based testing for meaningful invariants.
- Preserve failing seeds and replay information for reproducibility.
- Keep deterministic fixtures reproducible without unnecessarily restricting property exploration.
- Use established linting and architecture tools for static enforcement.
- Do not recreate general-purpose linters inside application tests.
- Avoid tests that merely assert implementation shape or trivial third-party behavior.
- Never weaken assertions to obtain passing results.
- Separate deterministic tests from live, paid, native, and long-running qualification.
- Report only verification that actually executed.

## Engineering tooling

- Use the configured TypeScript, ESLint, Prettier, dependency-cruiser, Knip, and testing toolchain.
- Prefer existing rules and native tooling before implementing custom enforcement.
- Keep one authoritative enforcement mechanism per responsibility unless duplication is justified.
- Do not add unnecessary custom tooling.
- Preserve Husky, lint-staged, Commitlint, and CI safeguards.
- Never disable or weaken quality gates to conceal failures.
- Do not bypass Git hooks without explicit authorization and documented justification.

## Git and pull requests

- Use descriptive feature branches and Conventional Commits.
- Preserve existing user-owned changes.
- Inspect the complete staged diff before committing.
- Do not stage unrelated files.
- Do not push directly to protected branches.
- Submit implementation changes through draft pull requests.
- Complete the canonical pull request template accurately.
- Provide meaningful implementation maps, engineering decisions, test evidence, and reviewer guidance.
- Explicitly disclose known limitations and unverified guarantees.
- Do not self-approve, dismiss review findings, or merge without authorization.
- Treat approval as applying to the reviewed commit SHA.

## Living documentation and visual identity

Every implementation PR evaluates its documentation impact:

- Update canonical docs and README sections affected by material changes.
- Regenerate affected artwork with `pnpm brand` and inspect the rendered result.
- Keep documentation and affected artwork in the same PR; avoid unrelated changes.
- Preserve the established visual identity unless explicitly redesigned.
- Capability and milestone claims require acceptance evidence; never advertise a capability before its criteria are met.
- Illustrative demonstrations stay labeled unless captured from the implementation.

Documentation consistency is part of the Definition of Done.

## Verification

Before requesting review:

1. Inspect the complete diff.
2. Remove unnecessary complexity and redundant code.
3. Verify architectural and security boundaries.
4. Run the repository's canonical quality gate.
5. Verify the production build and relevant executable smoke paths.
6. Confirm that tests establish the claimed behavior.
7. Report failures, limitations, and unexecuted checks accurately.
8. Complete the pull request review package.

A passing quality gate does not replace engineering review.

Do not claim completion when acceptance criteria remain unmet.

## Scope discipline

Follow the current issue, pull request, and explicitly authorized task scope.

Do not treat temporary task restrictions as permanent architectural rules.

Do not perform unrelated implementation, external publication, destructive operations, or paid service usage without authorization.

When a material requirement cannot be satisfied, report the blocker instead of inventing evidence or weakening the requirement.

Build Urbuddy, not a framework for building Urbuddy.
