import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parseEnv } from "node:util";

import { appError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

const fileSettings = [
  "URBUDDY_STT_PROVIDER",
  "URBUDDY_STT_MODEL",
  "URBUDDY_TRANSLATION_PROVIDER",
  "URBUDDY_TRANSLATION_MODEL",
  "URBUDDY_TRANSLATION_SOURCE_LANGUAGE",
  "URBUDDY_TRANSLATION_TARGET_LANGUAGE",
  "URBUDDY_META_API_KEY",
  "URBUDDY_OPENAI_API_KEY",
] as const;

const MAX_ENV_BYTES = 64 * 1024;

function readEnvironmentFile(file: string): ReturnType<typeof parseEnv> | undefined {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_ENV_BYTES) {
      return undefined;
    }
    const buffer = Buffer.alloc(MAX_ENV_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) {
        return parseEnv(buffer.toString("utf8", 0, length));
      }
      length += count;
    }
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

export function loadOperationEnvironment(
  processEnvironment: Environment,
  file?: string,
): Result<Environment, AppError> {
  const values: Record<string, string> = {};
  if (file !== undefined) {
    let parsed: ReturnType<typeof readEnvironmentFile>;
    try {
      parsed = readEnvironmentFile(file);
    } catch {
      return err(appError("CONFIG_INVALID", "could not load the selected environment file"));
    }
    if (parsed === undefined) {
      return err(appError("CONFIG_INVALID", "environment file must be regular and at most 64 KiB"));
    }
    for (const name of fileSettings) {
      const value = parsed[name];
      if (value !== undefined) {
        values[name] = value;
      }
    }
  }
  for (const [name, value] of Object.entries(processEnvironment)) {
    if (value !== undefined) {
      values[name] = value;
    }
  }
  return ok(Object.freeze(values));
}
