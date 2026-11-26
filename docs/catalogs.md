# Catalogs (implemented)

Typed definitions live in `src/kernel/`; every entry below is enforced by
code, not just documented. Adding an entry without its enforcement is a
review-blocking defect.

## Commands (`src/kernel/commands.ts`)

| name              | enforced by                                          |
| ----------------- | ---------------------------------------------------- |
| `doctor [--json]` | `parseCommandRequest` + commander action in `cli.ts` |
| `version`         | commander action in `cli.ts`                         |

`help` is provided by commander itself and is intentionally outside the
typed catalog. Dispatch matches on the `CommandName` union exhaustively via
ts-pattern: a new name without a handler is a compile error.

## Exit codes (`src/kernel/exit-codes.ts`)

| name           | value | mapped from                                                    |
| -------------- | ----- | -------------------------------------------------------------- |
| `success`      | 0     | clean run, `--help`, `--version`                               |
| `generalError` | 1     | `RESOURCE_*`, `INTERNAL`, failing doctor                       |
| `usage`        | 2     | `VALIDATION_FAILED`, `UNSUPPORTED`, commander errors           |
| `configError`  | 3     | `CONFIG_INVALID` (container build fails before logging exists) |
| `cancelled`    | 130   | `CANCELLED` (SIGINT/SIGTERM during a run)                      |

Mapping is `exitCodeForError` in `cli.ts`, exhaustive over `ErrorCode`.

## Resources (`src/kernel/resources.ts`)

Closed set: `timer`. `ResourceScope.register` rejects anything else at
runtime; the union type rejects it at compile time. Extend only when a
component actually acquires the new kind (install-only-when-consumed
applies to catalog growth too).
