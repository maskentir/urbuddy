# Dependency rationale and ownership

Pinned exactly; `pnpm-lock.yaml` is the integrity record (`pnpm ls`
clean at adoption, reproducible via `pnpm install --frozen-lockfile`).
Rule: a dependency is installed only when a component consumes it.
Deferred libraries (p-queue, p-retry, execa, undici, ws,
OpenTelemetry, drizzle, xstate, …) are compat-checked but NOT installed.

## Runtime

| package    | version | license | engines         | consumed by                                            | owner               |
| ---------- | ------- | ------- | --------------- | ------------------------------------------------------ | ------------------- |
| commander  | 15.1.0  | MIT     | >=22.12         | `src/presentation/cli.ts` (help/version/doctor/--json) | presentation        |
| env-paths  | 4.0.0   | MIT     | >=20            | `src/platform/paths.ts`                                | platform            |
| ink        | 8.0.0   | MIT     | >=22            | `src/presentation/ink-smoke.tsx`                       | presentation        |
| pino       | 10.4.0  | MIT     | none declared   | `src/platform/logging.ts` transport (policy wrapper)   | platform            |
| neverthrow | 8.2.0   | MIT     | >=18, zero deps | `Result` contracts in kernel/config/lifecycle          | kernel              |
| react      | 19.3.1  | MIT     | >=0.10          | Ink peer                                               | presentation        |
| strip-ansi | 7.2.0   | MIT     | >=12            | `src/platform/output.ts` sanitize                      | platform            |
| ts-pattern | 5.9.2   | MIT     | none            | exhaustive command + exit-code dispatch                | kernel/presentation |
| zod        | 4.6.7   | MIT     | none            | config, commands, resources, log-level schemas         | kernel/modules      |

## Development

| package                   | version | license    | engines                 | used for                                              | owner        |
| ------------------------- | ------- | ---------- | ----------------------- | ----------------------------------------------------- | ------------ |
| typescript                | 5.9.3   | Apache-2.0 | >=14.17                 | strict typecheck, never weakened                      | bootstrap    |
| tsx                       | 4.23.15 | MIT        | >=18                    | `smoke`/`doctor`/`ink-smoke` scripts                  | bootstrap    |
| vitest                    | 5.1.2   | MIT        | ^22.12\|\|^24\|>=26     | deterministic tests                                   | tests        |
| @vitest/coverage-v8       | 5.1.2   | MIT        | inherits vitest         | coverage (pinned in lockstep, peer is exact)          | tests        |
| fast-check                | 4.11.0  | MIT        | >=12.17                 | seeded precedence property (seed 20261126)            | tests        |
| @types/react              | 19.3.3  | MIT        | n/a (types)             | satisfies ink peer `>=19.3.0`                         | presentation |
| @types/node               | 24.19.4 | MIT        | n/a (types)             | node builtins for the Node 24 target line             | platform     |
| eslint                    | 10.15.0 | MIT        | ^20.19\|\|^22.13\|>=24  | `pnpm lint`                                           | tooling      |
| typescript-eslint         | 8.74.0  | MIT        | ^18.18\|\|^20.9\|>=21.1 | `eslint.config.js` (peer range satisfied)             | tooling      |
| eslint-plugin-import-x    | 4.18.1  | MIT        | ^18.18\|\|^20.9\|>=21.1 | import order/duplicates (`import-x/*`)                | tooling      |
| @typescript-eslint/parser | 8.74.0  | MIT        | ^18.18\|\|^20.9\|>=21.1 | RuleTester TS parsing in `tests/eslint-rules.test.ts` | tooling      |
| prettier                  | 3.10.1  | MIT        | >=14                    | `pnpm format`                                         | tooling      |
| dependency-cruiser        | 18.9.0  | MIT        | ^22\|\|^24\|>=26        | layer rules in `.dependency-cruiser.js`               | tooling      |
| knip                      | 6.48.0  | ISC        | ^20.19\|>=22.12         | unused-export/code detection                          | tooling      |
| tsc-alias                 | 1.9.11  | MIT        | >=16.20.2               | rewrite `@` aliases in `dist` output                  | bootstrap    |

## Deliberately NOT adopted

| package                        | reason                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| typescript@7.0.2               | Latest line, but violates typescript-eslint peer (`<6.1.0`). Pinned to 5.9.3 until the peer range moves.                            |
| eslint-plugin-neverthrow@1.1.4 | Stale (2022-05-01, predates flat config); unverified under ESLint v9/10. Result discipline via tsc + tests instead.                 |
| ink-testing-library@4.0.0      | Stale (~18 mo), undeclared `from 'ink'` coupling, built against ink 5 era. Smoke path tested via `dryRun` + manual render.          |
| string-width (direct)          | Ink 8 wants `^8.3.0`; a direct v9 would nest alongside. No direct consumer yet.                                                     |
| custom logging facade          | Replaced by pino 10.4.0 transport + policy wrapper (injected clock, name-based redaction, live correlation). No parallel framework. |
| xstate, deferred libs          | Conditional/deferred: no consumer yet.                                                                                              |
| vite, react-devtools-core      | Peer-resolved transitively at install; not direct dependencies.                                                                     |
| vite-tsconfig-paths@6.1.1      | Tried for test-time alias resolution; removed after Vitest's native `resolve.tsconfigPaths` proved sufficient. Fewer deps win.      |
