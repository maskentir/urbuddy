import { readFileSync } from "node:fs";
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

type Environment = Readonly<Record<string, string | undefined>>;

export function loadOperationEnvironment(
  processEnvironment: Environment,
  file?: string,
): Result<Environment, AppError> {
  const values: Record<string, string> = {};
  if (file !== undefined) {
    let parsed: ReturnType<typeof parseEnv>;
    try {
      parsed = parseEnv(readFileSync(file, "utf8"));
    } catch {
      return err(appError("CONFIG_INVALID", "could not load the selected environment file"));
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
