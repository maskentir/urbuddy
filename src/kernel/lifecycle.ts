import { appError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

import type { ResourceId } from "./ids.js";
import { resourceKindSchema, type ResourceKind } from "./resources.js";

export interface ManagedResource {
  readonly id: ResourceId;
  readonly kind: ResourceKind;
  dispose(): Promise<void>;
}

type Settlement =
  { readonly status: "done" } | { readonly status: "abandoned" } | { readonly status: "failed" };

async function settleDispose(
  start: () => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<Settlement> {
  const pending = Promise.resolve().then(start);
  if (signal === undefined) {
    try {
      await pending;
      return { status: "done" };
    } catch {
      return { status: "failed" };
    }
  }
  if (signal.aborted) {
    return { status: "abandoned" };
  }
  let onAbort: () => void = () => undefined;
  const abortGate = new Promise<{ readonly status: "abandoned" }>((resolve) => {
    onAbort = () => resolve({ status: "abandoned" });
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      pending.then<Settlement, Settlement>(
        (): Settlement => ({ status: "done" }),
        (): Settlement => ({ status: "failed" }),
      ),
      abortGate,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function releaseFailure(id: ResourceId): AppError {
  return appError("RESOURCE_RELEASE_FAILED", "resource disposal failed", {
    details: { resourceId: id },
  });
}

interface TrackedResource {
  readonly resource: ManagedResource;
  settled: boolean;
  failed: boolean;
}

export class ResourceScope {
  private readonly resources: TrackedResource[] = [];
  private disposal: Promise<Result<void, AppError>> | undefined;
  private terminal: Result<void, AppError> | undefined;
  private failure: AppError | undefined;
  private disposalStarted = false;

  get size(): number {
    return this.resources.length;
  }

  get isDisposed(): boolean {
    return this.terminal !== undefined && this.terminal.isOk();
  }

  register(resource: ManagedResource): Result<void, AppError> {
    if (this.disposalStarted) {
      return err(appError("RESOURCE_ACQUIRE_FAILED", "scope is closed for registration"));
    }
    const kind = resourceKindSchema.safeParse(resource.kind);
    if (!kind.success) {
      return err(
        appError("RESOURCE_ACQUIRE_FAILED", `unknown resource kind: ${String(resource.kind)}`),
      );
    }
    this.resources.push({ resource, settled: false, failed: false });
    return ok(undefined);
  }

  async disposeAll(signal?: AbortSignal): Promise<Result<void, AppError>> {
    if (this.terminal !== undefined) {
      return this.terminal;
    }
    if (this.disposal !== undefined) {
      return this.disposal;
    }
    const run = this.runDisposal(signal);
    this.disposalStarted = true;
    this.disposal = run;
    try {
      return await run;
    } finally {
      if (this.disposal === run) {
        this.disposal = undefined;
      }
    }
  }

  private async runDisposal(signal: AbortSignal | undefined): Promise<Result<void, AppError>> {
    /** [correctness] Yield before touching shared state so a run that completes without awaiting never looks in-flight to a concurrent caller. */
    await Promise.resolve();
    for (let index = this.resources.length - 1; index >= 0; index -= 1) {
      const entry = this.resources[index];
      if (entry === undefined || entry.settled) {
        continue;
      }
      if (signal !== undefined && signal.aborted) {
        break;
      }
      const settled = await settleDispose(() => entry.resource.dispose(), signal);
      entry.settled = true;
      if (settled.status === "abandoned") {
        entry.failed = true;
        if (this.failure === undefined) {
          this.failure = appError("CANCELLED", "scope disposal abandoned", {
            details: { resourceId: entry.resource.id },
          });
        }
        break;
      }
      if (settled.status === "failed") {
        entry.failed = true;
        if (this.failure === undefined) {
          this.failure = releaseFailure(entry.resource.id);
        }
      }
    }
    for (let index = this.resources.length - 1; index >= 0; index -= 1) {
      const entry = this.resources[index];
      if (entry !== undefined && entry.settled && !entry.failed) {
        this.resources.splice(index, 1);
      }
    }
    const pending = this.resources.some((entry) => !entry.settled);
    if (this.failure !== undefined) {
      const outcome = err(this.failure);
      if (!pending) {
        this.terminal = outcome;
      }
      return outcome;
    }
    if (pending) {
      return err(appError("CANCELLED", "scope disposal cancelled"));
    }
    const outcome = ok(undefined);
    this.terminal = outcome;
    return outcome;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const outcome = await this.disposeAll();
    if (outcome.isErr()) {
      throw outcome.error;
    }
  }
}
