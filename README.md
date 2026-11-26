# urbuddy

Reproducible assistant runtime skeleton. Typed errors, injectable
identity/time, pure config, resource lifecycle, default-deny security,
and a tiny CLI with an Ink smoke path. See [AGENTS.md](./AGENTS.md) for
the working conventions.

## Requirements

Node >= 24 (repo targets the Node 24 line; `.nvmrc` pins 24).

## Quickstart

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm smoke
pnpm doctor
pnpm ink-smoke
```

## Scripts

| script                    | purpose                                                     |
| ------------------------- | ----------------------------------------------------------- |
| `check`                   | aggregate gate: typecheck, lint, test, cruise, knip, format |
| `typecheck`               | `tsc --noEmit` under the strict baseline                    |
| `build`                   | emit to `dist/` + `tsc-alias` rewrite + dist verify         |
| `test`                    | vitest, deterministic (seeded properties)                   |
| `test:coverage`           | v8 coverage over `src/`                                     |
| `lint`                    | eslint flat config                                          |
| `format` / `format:write` | prettier check / write                                      |
| `cruise`                  | dependency-cruiser layer + orphan rules                     |
| `knip`                    | unused export / file detection                              |
| `smoke` / `doctor`        | run `doctor` via tsx (text / `--json`)                      |
| `ink-smoke`               | run the Ink startup/shutdown path via tsx                   |

## Layout

`src/bootstrap` composition root and entry. `src/kernel` errors, branded
ids, clocks, lifecycle, correlation, log levels, and the enforced
catalogs (commands, exit codes, resources). `src/modules/config`
pure session loader (defaults < `URBUDDY_*` env < flags, frozen,
profiles never grant). `src/modules/security` default-deny policy.
`src/platform` paths (env-paths), structured logging, output helpers.
`src/presentation` commander CLI and the Ink smoke component. `tests/`
the deterministic suite. `docs/` covers implemented catalogs
([catalogs](./docs/catalogs.md)) and every dependency with rationale and
ownership ([dependencies](./docs/dependencies.md)).

## Configuration

Precedence: built-in defaults, then `URBUDDY_PROFILE`,
`URBUDDY_LOG_LEVEL`, `URBUDDY_DATA_ROOT`, `URBUDDY_ALLOW_EGRESS`,
`URBUDDY_ALLOW_CHILD`, then CLI flags (`--profile`, `--log-level`,
`--data-root`, `--allow-egress`, `--allow-child`). Profiles
(`development`, `simulation`, `evaluation`, `personal`, `offline`) can
only restrict: forbidden grants are `CONFIG_INVALID` (exit 3).
