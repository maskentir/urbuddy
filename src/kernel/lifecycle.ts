import { err, ok, type Result } from "neverthrow";

import { appError, type AppError } from "./errors.js";
import type { ResourceId } from "./ids.js";
import { resourceKindSchema, type ResourceKind } from "./resources.js";

export interface ManagedResource {
  readonly id: ResourceId;
  readonly kind: ResourceKind;
  dispose(): Promise<void>;
}

type DisposeOutcome = "done" | "aborted" | AppError;

async function settleDispose(
  dispose: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<DisposeOutcome> {
  if (signal === undefined) {
    try {
      await dispose;
      return "done";
    } catch (thrown: unknown) {
      const message = thrown instanceof Error ? thrown.message : "dispose threw";
      return appError("RESOURCE_RELEASE_FAILED", message);
    }
  }
  if (signal.aborted) {
    return "aborted";
  }
  let onAbort: () => void = () => undefined;
  const abortGate = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      dispose.then(
        (): DisposeOutcome => "done",
        (thrown: unknown): DisposeOutcome => {
          const message = thrown instanceof Error ? thrown.message : "dispose threw";
          return appError("RESOURCE_RELEASE_FAILED", message);
        },
      ),
      abortGate,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export class ResourceScope {
  private readonly resources: ManagedResource[] = [];
  private disposed = false;

  get size(): number {
    return this.resources.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  register(resource: ManagedResource): Result<void, AppError> {
    if (this.disposed) {
      return err(appError("RESOURCE_ACQUIRE_FAILED", "scope is already disposed"));
    }
    const kind = resourceKindSchema.safeParse(resource.kind);
    if (!kind.success) {
      return err(
        appError("RESOURCE_ACQUIRE_FAILED", `unknown resource kind: ${String(resource.kind)}`),
      );
    }
    this.resources.push(resource);
    return ok(undefined);
  }

  async disposeAll(signal?: AbortSignal): Promise<Result<void, AppError>> {
    if (this.disposed) {
      return ok(undefined);
    }
    this.disposed = true;
    let firstFailure: AppError | undefined;
    while (this.resources.length > 0) {
      const resource = this.resources.pop();
      if (resource === undefined) {
        break;
      }
      if (signal !== undefined && signal.aborted) {
        firstFailure = appError("CANCELLED", "scope disposal cancelled", {
          details: { resourceId: resource.id },
        });
        break;
      }
      const settled = await settleDispose(resource.dispose(), signal);
      if (settled === "aborted") {
        firstFailure = appError("CANCELLED", "scope disposal cancelled", {
          details: { resourceId: resource.id },
        });
        break;
      } else if (settled !== "done" && firstFailure === undefined) {
        firstFailure = settled;
      }
    }
    if (firstFailure !== undefined) {
      return err(firstFailure);
    }
    return ok(undefined);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.disposeAll();
  }
}

export function trackInterval(
  scope: ResourceScope,
  id: ResourceId,
  handle: NodeJS.Timeout,
): Result<void, AppError> {
  handle.unref();
  return scope.register({
    id,
    kind: "timer",
    dispose: () => {
      clearInterval(handle);
      return Promise.resolve();
    },
  });
}
