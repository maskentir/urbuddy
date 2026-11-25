import { AsyncLocalStorage } from "node:async_hooks";

import type { CorrelationId } from "./ids.js";

const storage = new AsyncLocalStorage<CorrelationId>();

export function currentCorrelationId(): CorrelationId | undefined {
  return storage.getStore();
}

export function runWithCorrelationId<T>(id: CorrelationId, fn: () => T): T {
  return storage.run(id, fn);
}
