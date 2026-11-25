import {
  COMMAND_NAMES,
  commandHelp,
  commandRequestSchema,
  parseCommandRequest,
} from "@kernel/commands";
import { EXIT_CODES } from "@kernel/exit-codes";
import { createDeterministicIdGenerator } from "@kernel/ids";
import { type ManagedResource, ResourceScope } from "@kernel/lifecycle";
import { type ResourceKind, RESOURCE_KINDS, resourceKindSchema } from "@kernel/resources";
import { describe, expect, it } from "vitest";

function fakeResource(id: string, dispose: () => Promise<void> | void): ManagedResource {
  return {
    id: id as ManagedResource["id"],
    kind: "timer",
    dispose: () => Promise.resolve(dispose()),
  };
}

describe("lifecycle", () => {
  it("rejects unknown kinds at registration", () => {
    const scope = new ResourceScope();
    const ids = createDeterministicIdGenerator("lc");
    const bad = {
      id: ids.resourceId(),
      kind: "teleporter" as unknown as ResourceKind,
      dispose: () => Promise.resolve(),
    };
    const result = scope.register(bad);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("RESOURCE_ACQUIRE_FAILED");
    }
    expect(scope.size).toBe(0);
  });

  it("rejects registration after disposal", async () => {
    const scope = new ResourceScope();
    expect((await scope.disposeAll()).isOk()).toBe(true);
    const result = scope.register(fakeResource("r-1", () => undefined));
    expect(result.isErr()).toBe(true);
  });

  it("disposes LIFO and reports success", async () => {
    const scope = new ResourceScope();
    const order: string[] = [];
    const ids = createDeterministicIdGenerator("lc");
    for (const name of ["first", "second", "third"]) {
      const registered = scope.register({
        id: ids.resourceId(),
        kind: "timer",
        dispose: () => {
          order.push(name);
          return Promise.resolve();
        },
      });
      expect(registered.isOk()).toBe(true);
    }
    const disposed = await scope.disposeAll();
    expect(disposed.isOk()).toBe(true);
    expect(order).toEqual(["third", "second", "first"]);
    expect((await scope.disposeAll()).isOk()).toBe(true);
  });

  it("attempts every resource even after a failure and reports the first", async () => {
    const scope = new ResourceScope();
    const ids = createDeterministicIdGenerator("lc");
    const released: string[] = [];
    scope.register({
      id: ids.resourceId(),
      kind: "timer",
      dispose: () => {
        released.push("good");
        return Promise.resolve();
      },
    });
    scope.register({
      id: ids.resourceId(),
      kind: "timer",
      dispose: () => Promise.reject(new Error("disk gone")),
    });
    const disposed = await scope.disposeAll();
    expect(disposed.isErr()).toBe(true);
    if (disposed.isErr()) {
      expect(disposed.error.code).toBe("RESOURCE_RELEASE_FAILED");
    }
    expect(released).toEqual(["good"]);
  });

  it("stops interval callbacks after dispose", async () => {
    const scope = new ResourceScope();
    const ids = createDeterministicIdGenerator("lc");
    let ticks = 0;
    const handle = setInterval(() => {
      ticks += 1;
    }, 5);
    handle.unref();
    const tracked = scope.register({
      id: ids.resourceId(),
      kind: "timer",
      dispose: () => {
        clearInterval(handle);
        return Promise.resolve();
      },
    });
    expect(tracked.isOk()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ticks).toBeGreaterThan(0);
    const stopped = ticks;
    expect((await scope.disposeAll()).isOk()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ticks).toBe(stopped);
  });

  it("concurrent disposeAll disposes once and reports ok to both", async () => {
    const scope = new ResourceScope();
    const ids = createDeterministicIdGenerator("lc");
    let releases = 0;
    scope.register({
      id: ids.resourceId(),
      kind: "timer",
      dispose: () => {
        releases += 1;
        return Promise.resolve();
      },
    });
    const [first, second] = await Promise.all([scope.disposeAll(), scope.disposeAll()]);
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(releases).toBe(1);
  });

  it("abort during disposal stops early with the cancelled code", async () => {
    const scope = new ResourceScope();
    const ids = createDeterministicIdGenerator("lc");
    const released: string[] = [];
    const gate = (): Promise<void> => new Promise(() => undefined);
    scope.register({
      id: ids.resourceId(),
      kind: "timer",
      dispose: () => {
        released.push("early");
        return Promise.resolve();
      },
    });
    const stuckId = ids.resourceId();
    scope.register({
      id: stuckId,
      kind: "timer",
      dispose: () => {
        released.push("stuck");
        return gate();
      },
    });
    const controller = new AbortController();
    const disposing = scope.disposeAll(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const outcome = await disposing;
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("CANCELLED");
      expect(outcome.error.details).toEqual({ resourceId: stuckId });
    }
    expect(released).toEqual(["stuck"]);
    expect(scope.size).toBe(1);
    expect(scope.isDisposed).toBe(false);
    expect((await scope.disposeAll()).isOk()).toBe(true);
    expect(released).toEqual(["stuck", "early"]);
  });

  it("pre-aborted signal skips disposal with the cancelled code", async () => {
    const scope = new ResourceScope();
    const ids = createDeterministicIdGenerator("lc");
    let released = false;
    scope.register({
      id: ids.resourceId(),
      kind: "timer",
      dispose: () => {
        released = true;
        return Promise.resolve();
      },
    });
    const controller = new AbortController();
    controller.abort();
    const outcome = await scope.disposeAll(controller.signal);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("CANCELLED");
    }
    expect(released).toBe(false);
    expect(scope.size).toBe(1);
  });

  it("concurrent callers observe the same failure outcome", async () => {
    const scope = new ResourceScope();
    const ids = createDeterministicIdGenerator("lc");
    scope.register({
      id: ids.resourceId(),
      kind: "timer",
      dispose: () => Promise.reject(new Error("gone")),
    });
    const [first, second] = await Promise.all([scope.disposeAll(), scope.disposeAll()]);
    expect(first.isErr()).toBe(true);
    expect(second.isErr()).toBe(true);
    if (first.isErr() && second.isErr()) {
      expect(first.error).toBe(second.error);
      expect(first.error.code).toBe("RESOURCE_RELEASE_FAILED");
    }
  });

  it("records synchronous disposer throws instead of rejecting", async () => {
    const scope = new ResourceScope();
    const ids = createDeterministicIdGenerator("lc");
    scope.register({
      id: ids.resourceId(),
      kind: "timer",
      dispose: (): Promise<void> => {
        throw new Error("sync failure");
      },
    });
    const outcome = await scope.disposeAll();
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("RESOURCE_RELEASE_FAILED");
      expect(outcome.error.message).toBe("sync failure");
    }
  });

  it("async disposal surfaces cleanup failures instead of swallowing them", async () => {
    const scope = new ResourceScope();
    const ids = createDeterministicIdGenerator("lc");
    scope.register({
      id: ids.resourceId(),
      kind: "timer",
      dispose: () => Promise.reject(new Error("disk gone")),
    });
    await expect(scope[Symbol.asyncDispose]()).rejects.toMatchObject({
      code: "RESOURCE_RELEASE_FAILED",
    });
  });
});

describe("resource catalog", () => {
  it("accepts only the closed kind set", () => {
    expect([...RESOURCE_KINDS]).toEqual(["timer"]);
    expect(resourceKindSchema.safeParse("timer").success).toBe(true);
    expect(resourceKindSchema.safeParse("teleporter").success).toBe(false);
  });
});

describe("exit codes", () => {
  it("uses the fixed exit-code values", () => {
    expect(EXIT_CODES).toEqual({
      success: 0,
      generalError: 1,
      usage: 2,
      configError: 3,
      cancelled: 130,
    });
  });
});

describe("commands", () => {
  it("catalog holds doctor and version with help text", () => {
    expect([...COMMAND_NAMES]).toEqual(["doctor", "version"]);
    for (const name of COMMAND_NAMES) {
      expect(commandHelp(name).length).toBeGreaterThan(0);
    }
    expect(commandRequestSchema.safeParse({ name: "version", json: false }).success).toBe(true);
    expect(parseCommandRequest({ name: "doctor", json: true }).isOk()).toBe(true);
    expect(parseCommandRequest({ name: "rm -rf", json: false }).isErr()).toBe(true);
  });
});
