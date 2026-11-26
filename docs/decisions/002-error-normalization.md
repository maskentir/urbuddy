# ADR-002: Branded, fail-closed error normalization

Status: accepted.

## Context

Provider SDKs, subprocesses, and foreign libraries throw arbitrary
values, including objects shaped like application errors with
attacker- or vendor-controlled messages. Logging or displaying those
messages leaks secrets and breaks exit-code contracts (notably the
130-on-cancellation path).

## Decision

Only errors created by the `appError` factory carry a non-enumerable
brand; `isAppError` requires it, so structural lookalikes are never
trusted. `toAppError` is the single normalization path: factory
errors pass through untouched, `AbortError` maps to `CANCELLED`, and
everything else becomes `INTERNAL` with a caller-supplied safe
fallback. Foreign text never reaches `message`, `details`, logs, or
user-facing output.

## Consequences

Diagnostics keep precise codes and correlation IDs while carrying no
foreign text. Any new error producer must go through the factory;
shape-matching shortcuts are rejected by regression tests, including
hostile-Proxy totality probes.
