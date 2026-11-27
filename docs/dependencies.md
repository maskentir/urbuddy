# Dependency rationale and ownership

Pinned exactly; `pnpm-lock.yaml` is the integrity record (`pnpm ls`
clean at adoption, reproducible via `pnpm install --frozen-lockfile`).
Rule: a dependency is installed only when a component consumes it.
Deferred libraries (p-queue, p-retry, execa, undici,
OpenTelemetry, xstate, …) are compat-checked but NOT installed.

## Runtime

| package           | version | license    | engines         | consumed by                                                      | owner               |
| ----------------- | ------- | ---------- | --------------- | ---------------------------------------------------------------- | ------------------- |
| better-sqlite3    | 13.2.0  | MIT        | >=22            | `src/platform/persistence/store.ts` (native driver, lazy-loaded) | platform            |
| drizzle-orm       | 0.45.4  | Apache-2.0 | none            | `src/platform/persistence/` schema + queries                     | platform            |
| commander         | 15.1.0  | MIT        | >=22.12         | `src/presentation/cli.ts` (help/version/doctor/--json)           | presentation        |
| @langchain/core   | 1.5.1   | MIT        | >=20            | model gateway contracts consumed by the translation adapter      | adapters            |
| @langchain/openai | 1.8.5   | MIT        | >=22            | `src/adapters/translation/openai.ts` (ChatOpenAI transport)      | adapters            |
| env-paths         | 4.0.0   | MIT        | >=20            | `src/platform/paths.ts`                                          | platform            |
| ink               | 8.0.0   | MIT        | >=22            | `src/presentation/ink-smoke.tsx`                                 | presentation        |
| pino              | 10.4.0  | MIT        | none declared   | `src/platform/logging.ts` transport (policy wrapper)             | platform            |
| neverthrow        | 8.2.0   | MIT        | >=18, zero deps | `Result` contracts in kernel/config/lifecycle                    | kernel              |
| react             | 19.3.1  | MIT        | >=0.10          | Ink peer                                                         | presentation        |
| strip-ansi        | 7.2.0   | MIT        | >=12            | `src/platform/output.ts` sanitize                                | platform            |
| ts-pattern        | 5.9.2   | MIT        | none            | exhaustive command + exit-code dispatch                          | kernel/presentation |
| zod               | 4.6.7   | MIT        | none            | config, resources, log-level schemas                             | kernel/modules      |
| ws                | 8.23.0  | MIT        | >=10            | `src/adapters/speech/` WebSocket client + local test server      | adapters            |

## Development

| package                         | version | license    | engines                 | used for                                              | owner        |
| ------------------------------- | ------- | ---------- | ----------------------- | ----------------------------------------------------- | ------------ |
| typescript                      | 5.9.3   | Apache-2.0 | >=14.17                 | strict typecheck, never weakened                      | bootstrap    |
| tsx                             | 4.23.15 | MIT        | >=18                    | `smoke`/`doctor`/`ink-smoke` scripts                  | bootstrap    |
| vitest                          | 5.1.2   | MIT        | ^22.12\|\|^24\|>=26     | deterministic tests                                   | tests        |
| @vitest/coverage-v8             | 5.1.2   | MIT        | inherits vitest         | coverage (pinned in lockstep, peer is exact)          | tests        |
| fast-check                      | 4.11.0  | MIT        | >=12.17                 | seeded precedence property (seed 20261126)            | tests        |
| @types/react                    | 19.3.3  | MIT        | n/a (types)             | satisfies ink peer `>=19.3.0`                         | presentation |
| @types/better-sqlite3           | 9.6.0   | MIT        | n/a (types)             | native driver declarations                            | platform     |
| @types/node                     | 24.19.4 | MIT        | n/a (types)             | node builtins for the Node 24 target line             | platform     |
| eslint                          | 10.15.0 | MIT        | ^20.19\|\|^22.13\|>=24  | `pnpm lint`                                           | tooling      |
| typescript-eslint               | 8.74.0  | MIT        | ^18.18\|\|^20.9\|>=21.1 | `eslint.config.js` (peer range satisfied)             | tooling      |
| eslint-plugin-import-x          | 4.18.1  | MIT        | ^18.18\|\|^20.9\|>=21.1 | import order/duplicates (`import-x/*`)                | tooling      |
| @typescript-eslint/parser       | 8.74.0  | MIT        | ^18.18\|\|^20.9\|>=21.1 | RuleTester TS parsing in `tests/eslint-rules.test.ts` | tooling      |
| prettier                        | 3.10.1  | MIT        | >=14                    | `pnpm format`                                         | tooling      |
| dependency-cruiser              | 18.9.0  | MIT        | ^22\|\|^24\|>=26        | layer rules in `.dependency-cruiser.js`               | tooling      |
| knip                            | 6.48.0  | ISC        | ^20.19\|>=22.12         | unused-export/code detection                          | tooling      |
| tsc-alias                       | 1.9.11  | MIT        | >=16.20.2               | rewrite `@` aliases in `dist` output                  | bootstrap    |
| husky                           | 9.1.7   | MIT        | >=18                    | pre-commit + pre-push hooks (fast, check-only)        | tooling      |
| lint-staged                     | 17.6.2  | MIT        | >=22.22.1               | staged-file gate (`--fix` off: verify only)           | tooling      |
| @commitlint/cli                 | 21.2.4  | MIT        | >=22.12                 | conventional-commit enforcement on commit-msg         | tooling      |
| @commitlint/config-conventional | 21.2.4  | MIT        | n/a (config)            | commit message ruleset                                | tooling      |
| ink-testing-library             | 4.0.0   | MIT        | >=18                    | real Ink component render assertions                  | tests        |
| @types/ws                       | 8.18.1  | MIT        | n/a (types)             | `ws` declarations                                     | adapters     |

## Deliberately NOT adopted

| package                        | reason                                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typescript@7.0.2               | Latest line, but violates typescript-eslint peer (`<6.1.0`). Pinned to 5.9.3 until the peer range moves.                                                                                       |
| eslint-plugin-neverthrow@1.1.4 | Stale (2022-05-01, predates flat config); unverified under ESLint v9/10. Result discipline via tsc + tests instead.                                                                            |
| string-width (direct)          | Ink 8 wants `^8.3.0`; a direct v9 would nest alongside. No direct consumer yet.                                                                                                                |
| custom logging facade          | Replaced by pino 10.4.0 transport + policy wrapper (injected clock, name-based redaction, live correlation). No parallel framework.                                                            |
| xstate, deferred libs          | Conditional/deferred: no consumer yet.                                                                                                                                                         |
| vite, react-devtools-core      | Peer-resolved transitively at install; not direct dependencies.                                                                                                                                |
| vite-tsconfig-paths@6.1.1      | Tried for test-time alias resolution; removed after Vitest's native `resolve.tsconfigPaths` proved sufficient. Fewer deps win.                                                                 |
| native Node WebSocket client   | Evaluated for the Muse adapter; rejected: no inbound payload bound, weak termination control for lifecycle tests, and no server for deterministic local protocol tests. `ws` covers all three. |

The translation adapter uses direct LangChain Chat Completions invocation,
strict completion and JSON validation, and an explicit tracing context. The
application scheduler and evaluation runner use the same application-owned
port and exchange no SDK types. See [ADR-007](decisions/007-live-language-engine.md)
for the wire contract and acceptance status.
