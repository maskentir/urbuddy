import { Writable } from "node:stream";

import type { Clock } from "@kernel/clock";
import { currentCorrelationId } from "@kernel/correlation";
import type { CorrelationId, SessionId } from "@kernel/ids";
import { type LogLevel } from "@kernel/log-level";
import pino from "pino";

export type LogFieldValue = string | number | boolean;

export interface LogContext {
  readonly sessionId?: SessionId;
  readonly correlationId?: CorrelationId;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly msg: string;
  readonly time: string;
  readonly sessionId?: string;
  readonly correlationId?: string;
  readonly fields?: Readonly<Record<string, LogFieldValue>>;
}

const REDACTED = "[redacted]";
const DROPPED = "[dropped]";

const SENSITIVE_SUBSTRINGS = ["secret", "password", "token", "auth", "cookie", "credential"];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  if (normalized === "apikey" || normalized === "accesstoken" || normalized === "refreshtoken") {
    return true;
  }
  return SENSITIVE_SUBSTRINGS.some((part) => normalized.includes(part));
}

/** [security] Name-based redaction only: values under unrecognized keys pass through, so callers must not log raw payloads. */
export function sanitizeFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, LogFieldValue> {
  const out: Record<string, LogFieldValue> = {};
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else {
      out[key] = DROPPED;
    }
  }
  return out;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly clock: Clock;
  readonly sink?: (line: string) => void;
  readonly context?: LogContext;
}

export interface Logger {
  readonly level: LogLevel;
  trace(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  debug(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  fatal(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  child(context: LogContext): Logger;
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? defaultSink;
  const context = options.context ?? {};
  const base = pino(
    {
      level: options.level,
      timestamp: () => `,"time":"${options.clock.isoNow()}"`,
      base: null,
      formatters: {
        level: (label: string) => ({ level: label }),
      },
    },
    new Writable({
      write(chunk, _encoding, done): void {
        const line = chunk.toString();
        sink(line.endsWith("\n") ? line.slice(0, -1) : line);
        done();
      },
    }),
  );

  const write = (
    level: LogLevel,
    msg: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    const record: Record<string, unknown> = {};
    if (context.sessionId !== undefined) {
      record["sessionId"] = context.sessionId;
    }
    const correlationId = context.correlationId ?? currentCorrelationId();
    if (correlationId !== undefined) {
      record["correlationId"] = correlationId;
    }
    if (fields !== undefined) {
      record["fields"] = sanitizeFields(fields);
    }
    base[level](record, msg);
  };

  return {
    level: options.level,
    trace: (msg, fields) => {
      write("trace", msg, fields);
    },
    debug: (msg, fields) => {
      write("debug", msg, fields);
    },
    info: (msg, fields) => {
      write("info", msg, fields);
    },
    warn: (msg, fields) => {
      write("warn", msg, fields);
    },
    error: (msg, fields) => {
      write("error", msg, fields);
    },
    fatal: (msg, fields) => {
      write("fatal", msg, fields);
    },
    child: (extra: LogContext) =>
      createLogger({
        level: options.level,
        clock: options.clock,
        sink,
        context: { ...context, ...extra },
      }),
  };
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}
