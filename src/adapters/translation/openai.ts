import "@langchain/core/context";

import { appError, type AppError } from "@kernel/errors";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
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
export const SUPPORTED_TRANSLATION_MODELS = ["gpt-6-luna", "gpt-6.1-terra"] as const;
export const TRANSLATE_ENDPOINT_ENV = "URBUDDY_TRANSLATE_ENDPOINT";
export const TRANSLATE_API_KEY_ENV = "URBUDDY_OPENAI_API_KEY";
const TRANSLATE_LOOPBACK_CREDENTIAL = "loopback-translate-credential";
const REQUEST_TIMEOUT_MS = 8_000;
const MODELS = new Set<string>(SUPPORTED_TRANSLATION_MODELS);

const providerCodes = z.enum([
  "invalid_api_key",
  "model_not_found",
  "insufficient_quota",
  "rate_limit_exceeded",
  "context_length_exceeded",
  "unsupported_parameter",
  "invalid_value",
]);
const httpCategories: Readonly<Partial<Record<number, string>>> = {
  400: "invalid-request",
  401: "authentication",
  403: "permission",
  404: "model-unavailable",
  422: "invalid-request",
  429: "rate-limit",
};
const failureMetadata = z.object({
  status: z.number().int().min(400).max(599).optional().catch(undefined),
  code: providerCodes.optional().catch(undefined),
  requestID: z
    .string()
    .regex(/^req_[a-zA-Z0-9]{8,64}$/)
    .optional()
    .catch(undefined),
});

function providerFailure(thrown: unknown, model: string): AppError {
  const metadata = failureMetadata.safeParse(thrown);
  const { status, code, requestID } = metadata.success ? metadata.data : {};
  const category =
    status === undefined
      ? thrown instanceof Error && thrown.name === "TimeoutError"
        ? "timeout"
        : thrown instanceof Error && thrown.constructor.name === "APIConnectionError"
          ? "transport"
          : "unknown"
      : (httpCategories[status] ?? (status >= 500 ? "provider-failure" : "http-error"));

  return appError("INTERNAL", "translation request failed", {
    details: {
      provider: "openai",
      model,
      category,
      ...(status === undefined ? {} : { httpStatus: String(status) }),
      ...(code === undefined ? {} : { providerCode: code }),
      ...(requestID === undefined ? {} : { requestId: requestID }),
    },
  });
}

const translationSchema = z.strictObject({
  translation: z.string().trim().min(1).max(4_000),
});
const completionSchema = z.object({
  choices: z.tuple([
    z.object({
      finish_reason: z.literal("stop"),
      message: z.object({
        role: z.literal("assistant"),
        refusal: z.null().optional(),
        content: z.string().max(24_000),
        tool_calls: z.tuple([]).optional(),
        function_call: z.null().optional(),
      }),
    }),
  ]),
});
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
});

export function resolveTranslationEndpoint(raw: string | undefined): Result<string, AppError> {
  if (raw === undefined || raw.trim() === "" || raw.trim() === OPENAI_API_BASE_URL) {
    return ok(OPENAI_API_BASE_URL);
  }
  try {
    const url = new URL(raw);
    if (
      url.hostname === "127.0.0.1" &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.port !== "" &&
      (url.pathname === "/" || url.pathname === "/v1") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    ) {
      return ok(url.toString().replace(/\/$/, ""));
    }
  } catch {
    return err(appError("CONFIG_INVALID", "translation endpoint is invalid"));
  }
  return err(appError("CONFIG_INVALID", "translation endpoint is not an authorized destination"));
}

export function isLoopbackTranslationEndpoint(raw: string | undefined): boolean {
  const resolved = resolveTranslationEndpoint(raw);
  return resolved.isOk() && resolved.value !== OPENAI_API_BASE_URL;
}

export interface OpenAITranslationOptions {
  readonly apiKey: string;
  readonly testEndpoint?: string;
  readonly modelId: string;
  readonly timeoutMs?: number;
}

export function createTranslationProviderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  modelId: string,
): Result<TranslationProvider, AppError> {
  const endpoint = resolveTranslationEndpoint(env[TRANSLATE_ENDPOINT_ENV]);
  if (endpoint.isErr()) {
    return err(endpoint.error);
  }
  if (!MODELS.has(modelId)) {
    return err(appError("CONFIG_INVALID", "unsupported OpenAI translation model"));
  }
  if (process.env["LANGCHAIN_TRACING"]) {
    return err(
      appError("CONFIG_INVALID", "legacy LangChain tracing must be unset for translation"),
    );
  }
  if (endpoint.value !== OPENAI_API_BASE_URL) {
    return ok(
      createOpenAITranslationProvider({
        apiKey: TRANSLATE_LOOPBACK_CREDENTIAL,
        testEndpoint: endpoint.value,
        modelId,
      }),
    );
  }
  const apiKey = env[TRANSLATE_API_KEY_ENV]?.trim();
  if (!apiKey) {
    return err(
      appError(
        "CONFIG_INVALID",
        "translation credential is not configured (set URBUDDY_OPENAI_API_KEY)",
      ),
    );
  }
  return ok(createOpenAITranslationProvider({ apiKey, modelId }));
}

export function createOpenAITranslationProvider(
  options: OpenAITranslationOptions,
): TranslationProvider {
  const endpoint = resolveTranslationEndpoint(options.testEndpoint);
  if (endpoint.isErr()) {
    throw endpoint.error;
  }
  const loopback = endpoint.value !== OPENAI_API_BASE_URL;
  if (options.testEndpoint !== undefined && !loopback) {
    throw appError("CONFIG_INVALID", "translation test endpoint must be loopback");
  }
  const apiKey = loopback ? TRANSLATE_LOOPBACK_CREDENTIAL : options.apiKey.trim();
  const modelId = options.modelId;
  if (!apiKey || !MODELS.has(modelId)) {
    throw appError("CONFIG_INVALID", "invalid OpenAI translation credential or model");
  }
  const timeout = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const destination = `${endpoint.value}/chat/completions`;
  const model = new ChatOpenAI({
    apiKey,
    model: modelId,
    timeout,
    maxTokens: 1_024,
    maxRetries: 0,
    useResponsesApi: false,
    streaming: false,
    verbose: false,
    __includeRawResponse: true,
    reasoning: { effort: "none" },
    modelKwargs: { response_format: { type: "json_object" } },
    configuration: {
      baseURL: endpoint.value,
      organization: null,
      project: null,
      logLevel: "off",
      fetch: (url, init) => {
        if (String(url) !== destination) {
          throw appError("CONFIG_INVALID", "unexpected translation request destination");
        }
        return fetch(url, { ...init, redirect: "error" });
      },
    },
  });
  return {
    providerId: "openai",
    modelId,
    translate: async (
      request: TranslationRequest,
    ): Promise<Result<TranslationResult, AppError & { readonly usage?: TranslationUsage }>> => {
      if (request.signal.aborted) {
        return err(appError("CANCELLED", "translation cancelled"));
      }
      if (process.env["LANGCHAIN_TRACING"]) {
        return err(
          appError("CONFIG_INVALID", "legacy LangChain tracing must be unset for translation"),
        );
      }
      try {
        const message = await AsyncLocalStorageProviderSingleton.getInstance().run(
          { tracingEnabled: false },
          () =>
            model.invoke(
              request.messages.map((entry) =>
                entry.role === "system"
                  ? new SystemMessage(entry.content)
                  : new HumanMessage(entry.content),
              ),
              { signal: request.signal, callbacks: [] },
            ),
        );
        const raw: unknown = message.additional_kwargs["__raw_response"];
        const envelope = z.object({ usage: usageSchema.optional() }).safeParse(raw);
        const tokens = envelope.success ? envelope.data.usage : undefined;
        const usage =
          tokens === undefined
            ? undefined
            : {
                inputTokens: tokens.prompt_tokens,
                outputTokens: tokens.completion_tokens,
              };
        const validationFailure = (): Result<
          never,
          AppError & { readonly usage?: TranslationUsage }
        > =>
          err(
            Object.assign(
              appError("VALIDATION_FAILED", "translation completion failed validation"),
              usage === undefined ? {} : { usage },
            ),
          );
        const completion = completionSchema.safeParse(raw);
        if (!completion.success) {
          return validationFailure();
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(completion.data.choices[0].message.content);
        } catch {
          return validationFailure();
        }
        const validated = translationSchema.safeParse(parsed);
        if (!validated.success) {
          return validationFailure();
        }
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
        return err(providerFailure(thrown, modelId));
      }
    },
  };
}
