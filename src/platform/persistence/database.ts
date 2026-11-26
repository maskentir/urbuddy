import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appError, toAppError, type AppError } from "@kernel/errors";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { err, ok, type Result } from "neverthrow";

interface EvidenceSettings {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
  readonly busyTimeout: number;
  readonly fullfsync: number;
}

export interface EvidenceDatabase {
  readonly db: BetterSQLite3Database;
  readonly sqlite: InstanceType<typeof Database>;
  readonly settings: EvidenceSettings;
  close(): void;
}

export interface EvidenceDatabaseOptions {
  readonly busyTimeoutMs?: number;
  readonly maxPageCount?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 250;

function failure(message: string): AppError {
  return appError("VALIDATION_FAILED", message);
}

function migrationsFolder(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../../migrations"), resolve(here, "../../../migrations")];
  return candidates.find((candidate) => existsSync(join(candidate, "meta", "_journal.json")));
}

function journalEntryCount(folder: string): number {
  const raw = readFileSync(join(folder, "meta", "_journal.json"), "utf8");
  const parsed = JSON.parse(raw) as { entries?: unknown[] };
  return Array.isArray(parsed.entries) ? parsed.entries.length : 0;
}

function readSettings(sqlite: InstanceType<typeof Database>): EvidenceSettings {
  return {
    journalMode: sqlite.pragma("journal_mode", { simple: true }) as string,
    synchronous: sqlite.pragma("synchronous", { simple: true }) as number,
    foreignKeys: sqlite.pragma("foreign_keys", { simple: true }) as number,
    busyTimeout: sqlite.pragma("busy_timeout", { simple: true }) as number,
    fullfsync: sqlite.pragma("fullfsync", { simple: true }) as number,
  };
}

export function openEvidenceDatabase(
  path: string,
  options: EvidenceDatabaseOptions = {},
): Result<EvidenceDatabase, AppError> {
  let sqlite: InstanceType<typeof Database> | undefined;
  try {
    const dir = dirname(path);
    const dirExisted = existsSync(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!dirExisted) {
      chmodSync(dir, 0o700);
    }
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
        return err(failure("evidence database path must not be a symlink"));
      }
    }
    const dbPath = join(realpathSync(dir), basename(path));
    const folder = migrationsFolder();
    if (folder === undefined) {
      return err(appError("INTERNAL", "evidence migrations are unavailable"));
    }
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = FULL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    sqlite.pragma("fullfsync = ON");
    if (options.maxPageCount !== undefined) {
      sqlite.pragma(`max_page_count = ${options.maxPageCount}`);
    }
    const settings = readSettings(sqlite);
    if (
      settings.journalMode !== "wal" ||
      settings.synchronous !== 2 ||
      settings.foreignKeys !== 1
    ) {
      sqlite.close();
      return err(appError("INTERNAL", "evidence store durability settings not in effect"));
    }
    const hasJournal = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '__drizzle_migrations'`)
      .get() as { n: number };
    if (hasJournal.n > 0) {
      const applied = sqlite.prepare(`SELECT COUNT(*) AS n FROM __drizzle_migrations`).get() as {
        n: number;
      };
      if (applied.n > journalEntryCount(folder)) {
        sqlite.close();
        return err(failure("unsupported evidence schema version"));
      }
    }
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: folder });
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(file)) {
        chmodSync(file, 0o600);
      }
    }
    let closed = false;
    const handle: EvidenceDatabase = {
      db,
      sqlite,
      settings: readSettings(sqlite),
      close(): void {
        if (!closed) {
          closed = true;
          sqlite?.close();
        }
      },
    };
    return ok(handle);
  } catch (thrown: unknown) {
    sqlite?.close();
    if (
      typeof thrown === "object" &&
      thrown !== null &&
      (thrown as { code?: unknown }).code === "VALIDATION_FAILED"
    ) {
      return err(thrown as AppError);
    }
    return err(toAppError(thrown, "evidence store open failed"));
  }
}
