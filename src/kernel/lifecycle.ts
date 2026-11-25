import { err, ok, type Result } from "neverthrow";

import { appError, type AppError } from "./errors.js";
import type { ResourceId } from "./ids.js";
import { resourceKindSchema, type ResourceKind } from "./resources.js";

export interface ManagedResource {
  readonly id: ResourceId;
  readonly kind: ResourceKind;
  dispose(): Promise<void>;
}

type SettledDisposal =
  | { readonly status: "done" }
  | { readonly status: "abandoned" }
  | { readonly status: "failed"; readonly cause: unknown };

async function settleDispose(
  start: () => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<SettledDisposal> {
  let pending: Promise<void>;
  try {
    pending = start();
  } catch (thrown: unknown) {
    return { status: "failed", cause: thrown };
  }
  if (signal === undefined) {
    try {
      await pending;
      return { status: "done" };
    } catch (thrown: unknown) {
      return { status: "failed", cause: thrown };
    }
  }
  if (signal.aborted) {
    return { status: "abandoned" };
  }
  let onAbort: () => void = () => undefined;
  const abortGate = new Promise<{ readonly status: "abandoned" }>((resolve) => {
    onAbort = () => resolve({ status: "abandoned" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      pending.then(
        (): SettledDisposal => ({ status: "done" }),
        (thrown: unknown): SettledDisposal => ({ status: "failed", cause: thrown }),
      ),
      abortGate,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function releaseFailure(id: ResourceId, cause: unknown): AppError {
  const message = cause instanceof Error && cause.message !== "" ? cause.message : "dispose threw";
  return appError("RESOURCE_RELEASE_FAILED", message, { details: { resourceId: id } });
}

export class ResourceScope {
  private readonly resources: ManagedResource[] = [];
  private disposal: Promise<Result<void, AppError>> | undefined;
  private terminal: Result<void, AppError> | undefined;

  get size(): number {
    return this.resources.length;
  }

  get isDisposed(): boolean {
    return this.terminal !== undefined;
  }

  register(resource: ManagedResource): Result<void, AppError> {
    if (this.terminal !== undefined || this.disposal !== undefined) {
      return err(appError("RESOURCE_ACQUIRE_FAILED", "scope is closed for registration"));
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

  disposeAll(signal?: AbortSignal): Promise<Result<void, AppError>> {
    if (this.terminal !== undefined) {
      return Promise.resolve(this.terminal);
    }
    if (this.disposal !== undefined) {
      return this.disposal;
    }
    this.disposal = this.runDisposal(signal);
    return this.disposal;
  }

  private async runDisposal(signal: AbortSignal | undefined): Promise<Result<void, AppError>> {
    let firstFailure: AppError | undefined;
    while (this.resources.length > 0) {
      const resource = this.resources[this.resources.length - 1];
      if (resource === undefined) {
        break;
      }
      if (signal !== undefined && signal.aborted) {
        firstFailure = appError("CANCELLED", "scope disposal cancelled", {
          details: { resourceId: resource.id },
        });
        break;
      }
      const settled = await settleDispose(() => resource.dispose(), signal);
      this.resources.pop();
      if (settled.status === "abandoned") {
        firstFailure = appError("CANCELLED", "scope disposal abandoned", {
          details: { resourceId: resource.id },
        });
        break;
      }
      if (settled.status === "failed" && firstFailure === undefined) {
        firstFailure = releaseFailure(resource.id, settled.cause);
      }
    }
    const outcome = firstFailure === undefined ? ok(undefined) : err(firstFailure);
    if (this.resources.length === 0) {
      this.terminal = outcome;
    }
    this.disposal = undefined;
    return outcome;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const outcome = await this.disposeAll();
    if (outcome.isErr()) {
      throw outcome.error;
    }
  }
}
