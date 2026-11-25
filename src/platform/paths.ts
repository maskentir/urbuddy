import { appError, type AppError } from "@kernel/errors";
import envPaths from "env-paths";
import { err, ok, type Result } from "neverthrow";

export interface AppPaths {
  readonly data: string;
  readonly config: string;
  readonly cache: string;
  readonly log: string;
  readonly temp: string;
}

export function resolveAppPaths(
  appName: string,
  overrides?: { readonly dataRoot?: string },
): Result<AppPaths, AppError> {
  if (appName.trim().length === 0) {
    return err(appError("VALIDATION_FAILED", "app name must be a non-empty string"));
  }
  const paths = envPaths(appName, { suffix: "" });
  const data = overrides?.dataRoot ?? paths.data;
  if (data.trim().length === 0) {
    return err(appError("VALIDATION_FAILED", "resolved data path must be non-empty"));
  }
  return ok({
    data,
    config: paths.config,
    cache: paths.cache,
    log: paths.log,
    temp: paths.temp,
  });
}
