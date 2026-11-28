import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { TextDecoder } from "node:util";

import {
  createOpenAITranslationProvider,
  createTranslationProviderFromEnv,
  isLoopbackTranslationEndpoint,
  resolveTranslationEndpoint,
  TRANSLATE_API_KEY_ENV,
  TRANSLATE_ENDPOINT_ENV,
} from "@adapters/translation/openai";
import {
  DEFAULT_TRANSLATION_LANGUAGES,
  DEFAULT_TRANSLATION_MODEL,
} from "@modules/config/translation";
import { buildTranslationRequest } from "@modules/language/translation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function completionResponse(
  translation: string,
  model: string = DEFAULT_TRANSLATION_MODEL,
): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ translation }) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  });
}

class StubServer {
  readonly requests: RecordedRequest[] = [];
  private readonly server: Server;
  private listening: Promise<void>;

  constructor(
    private readonly respond: (request: RecordedRequest, response: ServerResponse) => void,
    private readonly hang = false,
  ) {
    this.server = createServer((request, response) => {
      void (async (): Promise<void> => {
        const body = await readBody(request);
        const recorded: RecordedRequest = {
          url: request.url ?? "",
          authorization: request.headers["authorization"],
          body:
            body.length === 0 ? undefined : (JSON.parse(new TextDecoder().decode(body)) as unknown),
        };
        this.requests.push(recorded);
        if (this.hang) {
          return;
        }
        this.respond(recorded, response);
      })();
    });
    this.listening = new Promise<void>((resolve, reject) => {
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });
    this.server.listen(0, "127.0.0.1");
  }

  async url(): Promise<string> {
    await this.listening;
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const stubs: StubServer[] = [];
afterEach(async () => {
  for (const stub of stubs.splice(0)) {
    await stub.close();
  }
});

function stubServer(
  respond: (request: RecordedRequest, response: ServerResponse) => void,
  hang = false,
): StubServer {
  const stub = new StubServer(respond, hang);
  stubs.push(stub);
  return stub;
}

describe("translation endpoint resolution", () => {
  it("pins production and accepts loopback test servers", () => {
    const production = resolveTranslationEndpoint(undefined);
    expect(production.isOk()).toBe(true);
    if (production.isOk()) {
      expect(production.value).toBe("https://api.openai.com/v1");
    }
    expect(resolveTranslationEndpoint("https://evil.example.com/v1").isErr()).toBe(true);
    expect(resolveTranslationEndpoint("::not-a-url::").isErr()).toBe(true);
    expect(isLoopbackTranslationEndpoint("http://127.0.0.1:9")).toBe(true);
    expect(isLoopbackTranslationEndpoint(undefined)).toBe(false);
  });
});

describe("OpenAI translation adapter (local stub)", () => {
  it("sends the pinned model with versioned prompt and captures usage", async () => {
    const stub = stubServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completionResponse("Jangan deploy dulu.", DEFAULT_TRANSLATION_MODEL));
    });
    const provider = createOpenAITranslationProvider({
      apiKey: "loopback-translate-credential",
      testEndpoint: await stub.url(),
      modelId: DEFAULT_TRANSLATION_MODEL,
    });
    const outcome = await provider.translate(
      buildTranslationRequest(
        "Don't deploy it yet.",
        ["The release is tonight."],
        DEFAULT_TRANSLATION_LANGUAGES,
        new AbortController().signal,
      ),
    );
    expect(outcome.isOk()).toBe(true);
    if (outcome.isOk()) {
      expect(outcome.value.text).toBe("Jangan deploy dulu.");
      expect(outcome.value.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
    }
    expect(stub.requests.length).toBe(1);
    const body = stub.requests[0]?.body as {
      readonly model?: unknown;
      readonly messages?: readonly { readonly role?: unknown; readonly content?: unknown }[];
    };
    expect(stub.requests[0]?.authorization).toBe("Bearer loopback-translate-credential");
    const joined = JSON.stringify(body.messages);
    const evaluatedPrompt = z
      .object({ system: z.string(), version: z.string() })
      .parse(
        JSON.parse(
          readFileSync(
            new URL("../evaluation/language/prompts/urbuddy-translation-v3.json", import.meta.url),
            "utf8",
          ),
        ),
      );
    expect(body.messages?.[0]).toEqual({
      role: "developer",
      content: `${evaluatedPrompt.system} Prompt version: ${evaluatedPrompt.version}.`,
    });
    expect(body.model).toBe("gpt-6.1-terra");
    expect(joined).toContain("Don't deploy it yet.");
    expect(stub.requests[0]?.body).toMatchObject({
      reasoning_effort: "none",
      max_completion_tokens: 1024,
      response_format: { type: "json_object" },
    });
    expect(stub.requests[0]?.body).not.toHaveProperty("temperature");
  });

  it("keeps inherited LangSmith tracing disabled during a configured model invocation", async () => {
    const inference = stubServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completionResponse("公開しないでください。"));
    });
    const tracing = stubServer((_request, response) => response.writeHead(200).end("{}"));
    vi.stubEnv("LANGSMITH_TRACING", "true");
    vi.stubEnv("LANGCHAIN_TRACING_V2", "true");
    vi.stubEnv("LANGSMITH_ENDPOINT", await tracing.url());
    vi.stubEnv("LANGSMITH_API_KEY", "test-sentinel");
    try {
      const model = createOpenAITranslationProvider({
        apiKey: "private-sentinel",
        modelId: "gpt-6.1-terra",
        testEndpoint: await inference.url(),
      });
      const outcome = await model.translate(
        buildTranslationRequest(
          "Do not publish.",
          [],
          { sourceLanguage: "en", targetLanguage: "ja" },
          new AbortController().signal,
        ),
      );
      expect(outcome.isOk()).toBe(true);
      expect(inference.requests[0]?.body).toMatchObject({
        model: "gpt-6.1-terra",
        reasoning_effort: "none",
        max_completion_tokens: 1024,
      });
      expect(tracing.requests).toHaveLength(0);
      vi.stubEnv("LANGCHAIN_TRACING", "true");
      const blocked = await model.translate(
        buildTranslationRequest(
          "second invocation",
          [],
          DEFAULT_TRANSLATION_LANGUAGES,
          new AbortController().signal,
        ),
      );
      expect(blocked.isErr()).toBe(true);
      expect(inference.requests).toHaveLength(1);
      expect(tracing.requests).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { finish: "length", refusal: null, translation: { translation: "valid JSON" } },
    { finish: "stop", refusal: "declined", translation: { translation: "valid JSON" } },
    { finish: "stop", refusal: null, translation: { translation: "valid JSON", extra: true } },
    { finish: "stop", refusal: null, translation: { translation: "   " } },
  ])("rejects incomplete or invalid completions while retaining usage: %j", async (sample) => {
    const stub = stubServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...JSON.parse(completionResponse("x")),
          choices: [
            {
              index: 0,
              finish_reason: sample.finish,
              message: {
                role: "assistant",
                content: JSON.stringify(sample.translation),
                refusal: sample.refusal,
              },
            },
          ],
        }),
      );
    });
    const provider = createOpenAITranslationProvider({
      apiKey: "sentinel",
      testEndpoint: await stub.url(),
      modelId: DEFAULT_TRANSLATION_MODEL,
    });
    const outcome = await provider.translate(
      buildTranslationRequest(
        "Hello.",
        [],
        DEFAULT_TRANSLATION_LANGUAGES,
        new AbortController().signal,
      ),
    );
    expect(outcome.isErr() && outcome.error).toMatchObject({
      code: "VALIDATION_FAILED",
      usage: { inputTokens: 50, outputTokens: 10 },
    });
  });

  it("never forwards an operator credential to a loopback stub", async () => {
    const stub = stubServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completionResponse("Baik."));
    });
    const created = createTranslationProviderFromEnv(
      {
        [TRANSLATE_API_KEY_ENV]: "REAL-OPERATOR-KEY-MUST-NOT-LEAVE",
        [TRANSLATE_ENDPOINT_ENV]: await stub.url(),
      },
      DEFAULT_TRANSLATION_MODEL,
    );
    expect(created.isOk()).toBe(true);
    if (created.isErr()) {
      return;
    }
    const outcome = await created.value.translate(
      buildTranslationRequest(
        "Hello.",
        [],
        DEFAULT_TRANSLATION_LANGUAGES,
        new AbortController().signal,
      ),
    );
    expect(outcome.isOk()).toBe(true);
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0]?.authorization).toBe("Bearer loopback-translate-credential");
    expect(stub.requests[0]?.authorization).not.toContain("REAL-OPERATOR-KEY");
  });

  it("needs no credential for loopback but fails closed for production", () => {
    expect(
      createTranslationProviderFromEnv(
        { [TRANSLATE_ENDPOINT_ENV]: "http://127.0.0.1:9" },
        DEFAULT_TRANSLATION_MODEL,
      ).isOk(),
    ).toBe(true);
    const missing = createTranslationProviderFromEnv(
      { URBUDDY_META_API_KEY: "wrong-provider-fixture" },
      DEFAULT_TRANSLATION_MODEL,
    );
    expect(JSON.stringify(missing)).not.toContain("wrong-provider-fixture");
    expect(
      createTranslationProviderFromEnv(
        { [TRANSLATE_API_KEY_ENV]: "translation-fixture" },
        DEFAULT_TRANSLATION_MODEL,
      ).isOk(),
    ).toBe(true);
    expect(missing.isErr()).toBe(true);
    if (missing.isErr()) {
      expect(missing.error.code).toBe("CONFIG_INVALID");
    }
  });

  it("rejects unauthorized destinations before any request", () => {
    expect(() =>
      createOpenAITranslationProvider({
        apiKey: "key",
        testEndpoint: "https://evil.example.com/v1",
        modelId: DEFAULT_TRANSLATION_MODEL,
      }),
    ).toThrow();
    const created = createTranslationProviderFromEnv(
      {
        [TRANSLATE_API_KEY_ENV]: "key",
        [TRANSLATE_ENDPOINT_ENV]: "https://evil.example.com/v1",
      },
      DEFAULT_TRANSLATION_MODEL,
    );
    expect(created.isErr()).toBe(true);
  });

  it("rejects malformed model output without committing it", async () => {
    const stub = stubServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: DEFAULT_TRANSLATION_MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "definitely not json" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    const provider = createOpenAITranslationProvider({
      apiKey: "key",
      testEndpoint: await stub.url(),
      modelId: DEFAULT_TRANSLATION_MODEL,
    });
    const outcome = await provider.translate(
      buildTranslationRequest(
        "Hello.",
        [],
        DEFAULT_TRANSLATION_LANGUAGES,
        new AbortController().signal,
      ),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it.each([
    [400, "unsupported_parameter", "invalid-request"],
    [401, "invalid_api_key", "authentication"],
    [403, "model_not_found", "permission"],
    [404, "model_not_found", "model-unavailable"],
    [429, "insufficient_quota", "rate-limit"],
    [500, "private-provider-code", "provider-failure"],
  ])("captures safe diagnostics for HTTP %i in one attempt", async (status, code, category) => {
    const stub = stubServer((_request, response) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "x-request-id": status === 500 ? "private-header-value" : "req_1234567890",
      });
      response.end(JSON.stringify({ error: { code, message: "private-provider-message" } }));
    });
    const provider = createOpenAITranslationProvider({
      apiKey: "key",
      testEndpoint: await stub.url(),
      modelId: DEFAULT_TRANSLATION_MODEL,
    });
    const outcome = await provider.translate(
      buildTranslationRequest(
        "Private fixture input.",
        [],
        DEFAULT_TRANSLATION_LANGUAGES,
        new AbortController().signal,
      ),
    );
    expect(outcome.isErr() && outcome.error).toMatchObject({
      code: "INTERNAL",
      details: {
        provider: "openai",
        model: DEFAULT_TRANSLATION_MODEL,
        category,
        httpStatus: String(status),
        ...(status === 500 ? {} : { providerCode: code, requestId: "req_1234567890" }),
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/private-provider|private-header|Private fixture/);
    expect(stub.requests).toHaveLength(1);
  });

  it("classifies a dropped connection as transport failure", async () => {
    const stub = stubServer((_request, response) => response.destroy());
    const provider = createOpenAITranslationProvider({
      apiKey: "key",
      testEndpoint: await stub.url(),
      modelId: DEFAULT_TRANSLATION_MODEL,
    });
    const outcome = await provider.translate(
      buildTranslationRequest(
        "Hello.",
        [],
        DEFAULT_TRANSLATION_LANGUAGES,
        new AbortController().signal,
      ),
    );
    expect(outcome.isErr() && outcome.error.details).toMatchObject({ category: "transport" });
    expect(stub.requests).toHaveLength(1);
  });

  it("fails a hanging request within its bound", async () => {
    const stub = stubServer(() => {
      throw new Error("must not respond");
    }, true);
    const provider = createOpenAITranslationProvider({
      apiKey: "key",
      testEndpoint: await stub.url(),
      timeoutMs: 100,
      modelId: DEFAULT_TRANSLATION_MODEL,
    });
    const started = Date.now();
    const outcome = await provider.translate(
      buildTranslationRequest(
        "Hello.",
        [],
        DEFAULT_TRANSLATION_LANGUAGES,
        new AbortController().signal,
      ),
    );
    expect(outcome.isErr() && outcome.error.details).toMatchObject({ category: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("signals cancellation to the transport while a request is active", async () => {
    const arrived = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const stub = stubServer((_request, response) => {
      response.once("close", () => disconnected.resolve());
      arrived.resolve();
    });
    const controller = new AbortController();
    const provider = createOpenAITranslationProvider({
      apiKey: "key",
      testEndpoint: await stub.url(),
      timeoutMs: 1_000,
      modelId: DEFAULT_TRANSLATION_MODEL,
    });
    const outcome = provider.translate(
      buildTranslationRequest("Hello.", [], DEFAULT_TRANSLATION_LANGUAGES, controller.signal),
    );
    try {
      await arrived.promise;
    } finally {
      controller.abort();
    }
    const result = await outcome;
    expect(result.isErr() && result.error.code).toBe("CANCELLED");
    await disconnected.promise;
    expect(stub.requests).toHaveLength(1);
  });

  it("reports cancellation without sending when already aborted", async () => {
    const stub = stubServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completionResponse("x"));
    });
    const provider = createOpenAITranslationProvider({
      apiKey: "key",
      testEndpoint: await stub.url(),
      modelId: DEFAULT_TRANSLATION_MODEL,
    });
    const controller = new AbortController();
    controller.abort();
    const outcome = await provider.translate(
      buildTranslationRequest("Hello.", [], DEFAULT_TRANSLATION_LANGUAGES, controller.signal),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("CANCELLED");
    }
    expect(stub.requests.length).toBe(0);
  });
});
