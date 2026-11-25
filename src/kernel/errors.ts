export const ERROR_CODES = [
  "CONFIG_INVALID",
  "VALIDATION_FAILED",
  "RESOURCE_ACQUIRE_FAILED",
  "RESOURCE_RELEASE_FAILED",
  "CANCELLED",
  "UNSUPPORTED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly correlationId?: string;
  readonly details?: Readonly<Record<string, string>>;
}

export interface AppErrorOptions {
  readonly correlationId?: string;
  readonly details?: Readonly<Record<string, string>>;
}

export function appError(
  code: ErrorCode,
  message: string,
  options: AppErrorOptions = {},
): AppError {
  const out: {
    code: ErrorCode;
    message: string;
    correlationId?: string;
    details?: Readonly<Record<string, string>>;
  } = { code, message };
  if (options.correlationId !== undefined) {
    out.correlationId = options.correlationId;
  }
  if (options.details !== undefined) {
    out.details = options.details;
  }
  return out;
}

export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["code"] === "string" &&
    (ERROR_CODES as readonly string[]).includes(record["code"]) &&
    typeof record["message"] === "string"
  );
}

/** Never throws, so catch blocks can convert without nesting further try blocks. */
export function toAppError(thrown: unknown, fallbackMessage: string): AppError {
  if (isAppError(thrown)) {
    return thrown;
  }
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    (thrown as { name?: unknown }).name === "AbortError"
  ) {
    return appError("CANCELLED", fallbackMessage);
  }
  if (thrown instanceof Error) {
    return appError("INTERNAL", thrown.message !== "" ? thrown.message : fallbackMessage);
  }
  return appError("INTERNAL", fallbackMessage);
}

export function formatError(error: AppError): string {
  const suffix = error.correlationId === undefined ? "" : ` (correlation ${error.correlationId})`;
  return `[${error.code}] ${error.message}${suffix}`;
}
