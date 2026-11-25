import { fixedClock } from "@kernel/clock";
import { runWithCorrelationId } from "@kernel/correlation";
import type { CorrelationId, SessionId } from "@kernel/ids";
import type { LogLevel } from "@kernel/log-level";
import { createLogger, sanitizeFields, type LogContext, type LogRecord } from "@platform/logging";
import { stripFormatting, toStableJson } from "@platform/output";
import { resolveAppPaths } from "@platform/paths";
import { describe, expect, it } from "vitest";

describe("paths", () => {
  it("resolves platform directories containing the app name", () => {
    const result = resolveAppPaths("urbuddy");
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw new Error("paths must resolve");
    }
    for (const dir of [
      result.value.data,
      result.value.config,
      result.value.cache,
      result.value.log,
      result.value.temp,
    ]) {
      expect(dir).toContain("urbuddy");
    }
    const again = resolveAppPaths("urbuddy");
    expect(again.isOk() && again.value).toEqual(result.value);
  });

  it("dataRoot override replaces only the data directory", () => {
    const base = resolveAppPaths("urbuddy");
    const overridden = resolveAppPaths("urbuddy", { dataRoot: "/sessions/abc" });
    expect(overridden.isOk()).toBe(true);
    if (base.isErr() || overridden.isErr()) {
      throw new Error("paths must resolve");
    }
    expect(overridden.value.data).toBe("/sessions/abc");
    expect(overridden.value.config).toBe(base.value.config);
    expect(overridden.value.log).toBe(base.value.log);
  });

  it("rejects empty app names", () => {
    expect(resolveAppPaths("   ").isErr()).toBe(true);
  });
});

describe("logging", () => {
  it("filters below the configured level and emits JSON lines", () => {
    const lines: string[] = [];
    const level: LogLevel = "warn";
    const logger = createLogger({
      level,
      clock: fixedClock(0),
      sink: (line) => {
        lines.push(line);
      },
    });
    logger.info("dropped");
    logger.warn("kept", { count: 2 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as unknown as LogRecord;
    expect(parsed).toMatchObject({
      level: "warn",
      msg: "kept",
      time: new Date(0).toISOString(),
      fields: { count: 2 },
    });
  });

  it("redacts sensitive fields and drops non-scalars", () => {
    const sanitized = sanitizeFields({
      apiKey: "shh",
      authToken: "shh",
      password: "shh",
      count: 3,
      nested: { deep: true },
      list: [1],
    });
    expect(sanitized).toEqual({
      apiKey: "[redacted]",
      authToken: "[redacted]",
      count: 3,
      list: "[dropped]",
      nested: "[dropped]",
      password: "[redacted]",
    });
  });

  it("child loggers merge context and ambient correlation fills in", () => {
    const lines: string[] = [];
    const clock = fixedClock(7_000);
    const logger = createLogger({
      level: "trace",
      clock,
      sink: (line) => {
        lines.push(line);
      },
    });
    const correlation = "corr-1" as unknown as CorrelationId;
    const context: LogContext = { sessionId: "sess-1" as SessionId };
    runWithCorrelationId(correlation, () => {
      logger.child(context).info("hello", { user: "ada" });
    });
    const ambient = JSON.parse(lines[0] ?? "{}") as unknown as LogRecord;
    expect(ambient.sessionId).toBe("sess-1");
    expect(ambient.correlationId).toBe("corr-1");
  });
});

describe("output", () => {
  it("strips ANSI formatting", () => {
    expect(stripFormatting("[31mred[0m plain")).toBe("red plain");
  });

  it("stable JSON sorts keys recursively", () => {
    expect(toStableJson({ b: 1, a: { d: 4, c: 3 } })).toBe(
      `{\n  "a": {\n    "c": 3,\n    "d": 4\n  },\n  "b": 1\n}`,
    );
  });
});
