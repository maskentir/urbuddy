import { appError, type AppError } from "@kernel/errors";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type {
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
  TranslationUsage,
} from "@modules/language/translation";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export const OPENAI_TRANSLATION_MODEL_ID = "gpt-6-luna";
export const TRANSLATE_ENDPOINT_ENV = "URBUDDY_TRANSLATE_ENDPOINT";
export const TRANSLATE_API_KEY_ENV = "OPENAI_API_KEY";
const TRANSLATE_LOOPBACK_CREDENTIAL = "loopback-translate-credential";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TRANSLATION_CHARS = 4_000;

const translationSchema = z.object({
  translation: z.string().min(1).max(MAX_TRANSLATION_CHARS),
});

const translationJsonSchema = {
  name: "translation",
  strict: true,
  schema: {
    type: "object",
    properties: { translation: { type: "string" } },
    required: ["translation"],
    additionalProperties: false,
  },
} as const;

function validateEndpoint(raw: string): Result<URL, AppError> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err(appError("VALIDATION_FAILED", "translation endpoint is invalid"));
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol === "https:" && url.host === "api.openai.com") {
    return ok(url);
  }
  if (loopback && (url.protocol === "http:" || url.protocol === "https:")) {
    return ok(url);
  }
  return err(
    appError("VALIDATION_FAILED", "translation endpoint is not an authorized destination"),
  );
}

export function resolveTranslationEndpoint(raw: string | undefined): Result<string, AppError> {
  if (raw === undefined || raw.trim() === "") {
    return ok(OPENAI_API_BASE_URL);
  }
  const validated = validateEndpoint(raw.trim());
  if (validated.isErr()) {
    return err(validated.error);
  }
  return ok(validated.value.toString().replace(/\/$/, ""));
}

export function isLoopbackTranslationEndpoint(raw: string | undefined): boolean {
  const resolved = resolveTranslationEndpoint(raw);
  if (resolved.isErr()) {
    return false;
  }
  try {
    return new URL(resolved.value).hostname !== "api.openai.com";
  } catch {
    return false;
  }
}

export interface OpenAITranslationOptions {
  readonly apiKey: string;
  readonly testEndpoint?: string;
  readonly modelId?: string;
  readonly timeoutMs?: number;
}

export function createTranslationProviderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Result<TranslationProvider, AppError> {
  const endpoint = resolveTranslationEndpoint(env[TRANSLATE_ENDPOINT_ENV]);
  if (endpoint.isErr()) {
    return err(endpoint.error);
  }
  if (isLoopbackTranslationEndpoint(env[TRANSLATE_ENDPOINT_ENV])) {
    return ok(
      createOpenAITranslationProvider({
        apiKey: TRANSLATE_LOOPBACK_CREDENTIAL,
        testEndpoint: endpoint.value,
      }),
    );
  }
  const apiKey = env[TRANSLATE_API_KEY_ENV];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return err(
      appError("CONFIG_INVALID", "translation credential is not configured (set OPENAI_API_KEY)"),
    );
  }
  return ok(createOpenAITranslationProvider({ apiKey }));
}

export function createOpenAITranslationProvider(
  options: OpenAITranslationOptions,
): TranslationProvider {
  if (options.apiKey.trim().length === 0) {
    throw appError("CONFIG_INVALID", "translation credential must not be empty");
  }
  if (options.testEndpoint !== undefined && validateEndpoint(options.testEndpoint).isErr()) {
    throw appError("VALIDATION_FAILED", "translation endpoint is not an authorized destination");
  }
  const modelId = options.modelId ?? OPENAI_TRANSLATION_MODEL_ID;
  const model = new ChatOpenAI({
    apiKey: options.apiKey,
    model: modelId,
    temperature: 0,
    timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    maxTokens: 1_024,
    maxRetries: 0,
    modelKwargs: {
      response_format: { type: "json_schema", json_schema: translationJsonSchema },
    },
    configuration: {
      baseURL: options.testEndpoint ?? OPENAI_API_BASE_URL,
    },
  });
  return {
    providerId: "openai",
    modelId,
    translate: async (
      request: TranslationRequest,
    ): Promise<Result<TranslationResult, AppError>> => {
      if (request.signal.aborted) {
        return err(appError("CANCELLED", "translation cancelled"));
      }
      try {
        const message = await model.invoke(
          request.messages.map((entry) =>
            entry.role === "system"
              ? new SystemMessage(entry.content)
              : new HumanMessage(entry.content),
          ),
          { signal: request.signal, timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS },
        );
        if (typeof message.content !== "string") {
          return err(appError("VALIDATION_FAILED", "translation response failed validation"));
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.content) as unknown;
        } catch {
          return err(appError("VALIDATION_FAILED", "translation response failed validation"));
        }
        const validated = translationSchema.safeParse(parsed);
        if (!validated.success) {
          return err(appError("VALIDATION_FAILED", "translation response failed validation"));
        }
        const usage = extractUsage(message);
        return ok({
          text: validated.data.translation,
          ...(usage === undefined ? {} : { usage }),
        });
      } catch (thrown: unknown) {
        if (request.signal.aborted) {
          return err(appError("CANCELLED", "translation cancelled"));
        }
        if (thrown instanceof SyntaxError) {
          return err(appError("VALIDATION_FAILED", "translation response failed validation"));
        }
        return err(appError("INTERNAL", "translation request failed"));
      }
    },
  };
}

function extractUsage(raw: unknown): TranslationUsage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const metadata = (raw as { readonly usage_metadata?: unknown }).usage_metadata;
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const tokens = metadata as { readonly input_tokens?: unknown; readonly output_tokens?: unknown };
  if (typeof tokens.input_tokens !== "number" || typeof tokens.output_tokens !== "number") {
    return undefined;
  }
  return { inputTokens: tokens.input_tokens, outputTokens: tokens.output_tokens };
}
