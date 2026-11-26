# Contributing to urbuddy

This is a skeleton foundation: small, strict, and fully verified. Keep it that way.

## Setup

Requires Node >= 24 (see `.nvmrc`; repo targets the Node 24 line).

```sh
pnpm install --frozen-lockfile
pnpm check
```

## Workflow

1. Pick a task that a component consumes. Do not add speculative modules.
2. Write the code under the strict `tsconfig` baseline. Do not weaken it.
3. Add deterministic tests in `tests/` (seeded properties only).
4. Update `docs/catalogs.md` if you touched an enforced catalog, and
   `docs/dependencies.md` if you consumed a new dependency (with version,
   license, engines, owner, and registry verification).
5. Run the full gate before handing off:

```sh
pnpm check
```

Also run `pnpm format:write` when you touched formatting.

## Conventions

- Errors: `AppError` + `neverthrow` `Result` at every fallible boundary.
  Cancellation is `AbortSignal`; aborts map to `CANCELLED` in `toAppError`.
- Identity/time are injected (`IdGenerator`, `Clock`). Tests use the
  deterministic generator and the fixed clock.
- Config flows defaults < `URBUDDY_*` env < CLI flags, then freezes.
- Logging carries only safe scalar fields; secrets are redacted,
  non-scalars dropped. See `src/platform/logging.ts`.
- CLI output: human text by default, `--json` emits stable (key-sorted) JSON.
- One owner per module; respect the dependency-cruiser layers.
