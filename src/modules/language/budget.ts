import { appError } from "@kernel/errors";
import { err } from "neverthrow";

import type { TranslationProvider } from "./translation.js";

interface TranslationBudget {
  readonly maxRequests: number;
  readonly maxInputBytesPerRequest: number;
}

const SESSION_TRANSLATION_BUDGET: TranslationBudget = {
  maxRequests: 4_096,
  maxInputBytesPerRequest: 16_000,
};

export function boundTranslationProvider(
  provider: TranslationProvider,
  budget: TranslationBudget = SESSION_TRANSLATION_BUDGET,
  onRefusal?: (reason: string, requests: number) => void,
): TranslationProvider {
  let requests = 0;
  return {
    providerId: provider.providerId,
    modelId: provider.modelId,
    translate: async (request) => {
      if (request.signal.aborted) return err(appError("CANCELLED", "translation cancelled"));
      if (requests >= budget.maxRequests) {
        const reason = `cumulative request ceiling of ${budget.maxRequests} reached`;
        onRefusal?.(reason, requests);
        return err(appError("CONFIG_INVALID", reason));
      }
      const serialized = request.messages
        .map((message) => `${message.role}:${message.content}`)
        .join("\n");
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > budget.maxInputBytesPerRequest) {
        const reason = `serialized request of ${bytes} bytes exceeds the ${budget.maxInputBytesPerRequest} byte ceiling`;
        onRefusal?.(reason, requests);
        return err(appError("CONFIG_INVALID", reason));
      }
      requests += 1;
      return provider.translate(request);
    },
  };
}
