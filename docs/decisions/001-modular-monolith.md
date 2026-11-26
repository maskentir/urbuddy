# ADR-001: Modular monolith with enforced boundaries

Status: accepted.

## Context

Urbuddy combines a runtime, several engines, native audio integration,
and an evaluation harness. The system needs clear ownership without
paying for distributed infrastructure it does not require as a
single-user local-first application.

## Decision

Build a feature-oriented modular monolith: `bootstrap`, `kernel`,
`modules`, `platform`, `adapters`, `presentation`, plus `native` and
`sidecars` outside the TypeScript tree. Enforce dependency direction
with dependency-cruiser on resolved imports (aliases and relative
paths alike), dead code with Knip, and conventions with ESLint.
Cross-module imports use canonical extensionless `@` aliases rewritten
at build time by `tsc-alias`; relative imports stay inside the owning
module.

## Consequences

Boundaries are verified on every change instead of documented once.
Package extraction later is possible but never required. Adding a
layer that the enforcement cannot see is a review-blocking defect.
