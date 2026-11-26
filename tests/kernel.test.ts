import { fixedClock, systemClock } from "@kernel/clock";
import { currentCorrelationId, runWithCorrelationId } from "@kernel/correlation";
import {
  appError,
  ERROR_CODES,
  formatError,
  isAppError,
  toAppError,
  type AppError,
} from "@kernel/errors";
import {
  createCryptoIdGenerator,
  createDeterministicIdGenerator,
  parseCorrelationId,
  parseResourceId,
  parseSessionId,
  type Branded,
} from "@kernel/ids";
import { describe, expect, it } from "vitest";

describe("errors", () => {
  it("declares the closed error code set", () => {
    expect([...ERROR_CODES]).toEqual([
      "CONFIG_INVALID",
      "VALIDATION_FAILED",
      "RESOURCE_ACQUIRE_FAILED",
      "RESOURCE_RELEASE_FAILED",
      "CANCELLED",
      "UNSUPPORTED",
      "INTERNAL",
    ]);
  });

  it("builds errors with optional fields only when defined", () => {
    const bare = appError("INTERNAL", "boom");
    expect(bare).toEqual({ code: "INTERNAL", message: "boom" });
    expect("correlationId" in bare).toBe(false);
    const full = appError("CONFIG_INVALID", "bad", {
      correlationId: "c-1",
      details: { field: "profile" },
    });
    expect(full.correlationId).toBe("c-1");
    expect(full.details).toEqual({ field: "profile" });
  });

  it("guards AppError shapes", () => {
    expect(isAppError(appError("INTERNAL", "x"))).toBe(true);
    expect(isAppError({ code: "NOPE", message: "x" })).toBe(false);
    expect(isAppError({ code: "INTERNAL" })).toBe(false);
    expect(isAppError({ code: "CANCELLED", message: "s3cr3t" })).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError("INTERNAL")).toBe(false);
  });

  it("converts thrown values without throwing", () => {
    const fromError = toAppError(new Error("kaput"), "fallback");
    expect(fromError.code).toBe("INTERNAL");
    expect(fromError.message).toBe("fallback");
    expect("details" in fromError).toBe(false);
    const controller = new AbortController();
    controller.abort();
    const fromAbort = toAppError(controller.signal.reason, "fallback");
    expect(fromAbort.code).toBe("CANCELLED");
    const passthrough: AppError = appError("INTERNAL", "x");
    expect(toAppError(passthrough, "fallback")).toBe(passthrough);
    const foreignShape = toAppError({ code: "CANCELLED", message: "s3cr3t" }, "fallback");
    expect(foreignShape).toEqual({ code: "INTERNAL", message: "fallback" });
    const fromUnknown = toAppError(undefined, "fallback");
    expect(fromUnknown).toEqual({ code: "INTERNAL", message: "fallback" });
  });

  it("never leaks foreign messages and never throws, even on hostile input", () => {
    const secret = toAppError(new Error("token=shh-abc"), "safe fallback");
    expect(secret.message).toBe("safe fallback");
    expect(formatError(secret)).toBe("[INTERNAL] safe fallback");
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    const converted = toAppError(hostile, "safe fallback");
    expect(converted).toEqual({ code: "INTERNAL", message: "safe fallback" });
  });

  it("formats with and without correlation", () => {
    expect(formatError(appError("INTERNAL", "boom"))).toBe("[INTERNAL] boom");
    expect(formatError(appError("INTERNAL", "boom", { correlationId: "c-9" }))).toBe(
      "[INTERNAL] boom (correlation c-9)",
    );
  });
});

describe("ids", () => {
  it("deterministic generator is predictable and unique", () => {
    const ids = createDeterministicIdGenerator("t");
    expect(ids.sessionId()).toBe("t-session-1");
    expect(ids.correlationId()).toBe("t-correlation-2");
    expect(ids.resourceId()).toBe("t-resource-3");
  });

  it("crypto generator produces unique ids", () => {
    const ids = createCryptoIdGenerator();
    const unwrap = <B extends string>(branded: Branded<string, B>): string => branded;
    expect(ids.sessionId()).not.toBe(ids.sessionId());
    expect(unwrap(ids.sessionId())).toEqual(expect.any(String));
  });

  it("parses branded ids and rejects junk", () => {
    expect(parseSessionId("s-1").isOk()).toBe(true);
    expect(parseCorrelationId("").isErr()).toBe(true);
    expect(parseResourceId(42).isErr()).toBe(true);
  });
});

describe("clock", () => {
  it("fixed clock only moves via advance", () => {
    const clock = fixedClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.isoNow()).toBe(new Date(1_000).toISOString());
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
  });

  it("system clock returns plausible values", () => {
    const clock = systemClock();
    expect(clock.now()).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(clock.isoNow()))).toBe(false);
  });
});

describe("cancellation with AbortSignal", () => {
  it("abort wakes listeners and marks the signal", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    controller.signal.addEventListener(
      "abort",
      () => {
        seen.push("a");
      },
      { once: true },
    );
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    controller.abort();
    expect(seen).toEqual(["a"]);
    expect(controller.signal.aborted).toBe(true);
    expect(() => controller.signal.throwIfAborted()).toThrow();
  });

  it("maps abort rejections to the cancelled code", async () => {
    const controller = new AbortController();
    const pending = new Promise<number>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(controller.signal.reason);
      });
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    try {
      await pending;
      throw new Error("unreachable");
    } catch (thrown: unknown) {
      expect(toAppError(thrown, "fallback").code).toBe("CANCELLED");
    }
  });
});

describe("correlation", () => {
  it("is undefined outside a scope and nests correctly", async () => {
    expect(currentCorrelationId()).toBeUndefined();
    const ids = createDeterministicIdGenerator("corr");
    const outer = ids.correlationId();
    const inner = ids.correlationId();
    runWithCorrelationId(outer, () => {
      expect(currentCorrelationId()).toBe(outer);
      runWithCorrelationId(inner, () => {
        expect(currentCorrelationId()).toBe(inner);
      });
      expect(currentCorrelationId()).toBe(outer);
    });
    expect(currentCorrelationId()).toBeUndefined();
    await runWithCorrelationId(outer, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
      expect(currentCorrelationId()).toBe(outer);
    });
  });
});
