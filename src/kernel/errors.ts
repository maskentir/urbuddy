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

const errorBrand: unique symbol = Symbol("urbuddy.error");

export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly correlationId?: string;
  readonly details?: Readonly<Record<string, string>>;
  readonly [errorBrand]?: true;
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
    [errorBrand]?: true;
  } = { code, message };
  Object.defineProperty(out, errorBrand, { value: true as const });
  if (options.correlationId !== undefined) {
    out.correlationId = options.correlationId;
  }
  if (options.details !== undefined) {
    out.details = options.details;
  }
  return out;
}

/** [correctness] The brand separates factory errors from foreign lookalikes, so shape alone never grants trust. */
export function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string | symbol, unknown>;
  if (record[errorBrand] !== true) {
    return false;
  }
  return (
    typeof record["code"] === "string" &&
    (ERROR_CODES as readonly string[]).includes(record["code"]) &&
    typeof record["message"] === "string"
  );
}

/** [correctness] Never throws, so catch blocks can convert without nesting further try blocks. */
export function toAppError(thrown: unknown, fallbackMessage: string): AppError {
  try {
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
    return appError("INTERNAL", fallbackMessage);
  } catch {
    return appError("INTERNAL", fallbackMessage);
  }
}

export function formatError(error: AppError): string {
  const suffix = error.correlationId === undefined ? "" : ` (correlation ${error.correlationId})`;
  return `[${error.code}] ${error.message}${suffix}`;
}
