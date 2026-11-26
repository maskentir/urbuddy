# ADR-003: ResourceScope retained under a consumer gate

Status: accepted, API frozen.

## Context

A proposal to remove `ResourceScope` in favor of native disposal
primitives was evaluated against the review-locked failure model:
shared concurrent disposal outcome, pre-abort skip with resume,
failure ownership with retained accounting, kind validation, and
`AppError`-typed outcomes. `AsyncDisposableStack` reports failures
but provides no shared in-flight outcome and no ownership retention;
`AbortSignal` is notification without ownership; `try/finally` is
lexical and cannot span the composition root's components.

## Decision

Retain `ResourceScope` with a frozen API. Registration closes
permanently once disposal begins, including after incomplete
disposal. `isDisposed` means fully released (terminal success), never
a failed-but-terminal scope. No new kinds, priorities, timeouts, or
lifecycle abstractions until a production consumer requires them.

## Consequences

The first production integration acquiring real resources (sidecar
process, audio handle, worker) must demonstrate that `ResourceScope`
reduces complexity while preserving correctness compared with native
disposal primitives. If that evidence does not justify it,
`ResourceScope` is removed or replaced at that point. Application,
session, stream, and operation lifetimes must remain independent;
shutdown orchestration stays separate from disposal.
