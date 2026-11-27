import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { TextDecoder } from "node:util";

import {
  createOpenAITranslationProvider,
  createTranslationProviderFromEnv,
  isLoopbackTranslationEndpoint,
  OPENAI_TRANSLATION_MODEL_ID,
  resolveTranslationEndpoint,
  TRANSLATE_API_KEY_ENV,
  TRANSLATE_ENDPOINT_ENV,
} from "@adapters/translation/openai";
import { buildTranslationRequest, DEFAULT_TECHNICAL_GLOSSARY } from "@modules/language/translation";
import { afterEach, describe, expect, it } from "vitest";

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

function completionResponse(translation: string): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: OPENAI_TRANSLATION_MODEL_ID,
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
    this.listening = new Promise<void>((resolve) => this.server.once("listening", resolve));
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
      response.end(completionResponse("Jangan deploy dulu."));
    });
    const provider = createOpenAITranslationProvider({
      apiKey: "loopback-translate-credential",
      testEndpoint: await stub.url(),
    });
    const outcome = await provider.translate(
      buildTranslationRequest(
        "Don't deploy it yet.",
        ["The release is tonight."],
        DEFAULT_TECHNICAL_GLOSSARY,
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
      readonly messages?: readonly { readonly content?: unknown }[];
    };
    expect(body.model).toBe(OPENAI_TRANSLATION_MODEL_ID);
    expect(stub.requests[0]?.authorization).toBe("Bearer loopback-translate-credential");
    const joined = JSON.stringify(body.messages);
    expect(joined).toContain("urbuddy-id-translation-v1");
    expect(joined).toContain("<source>Don't deploy it yet.</source>");
  });

  it("never forwards an operator credential to a loopback stub", async () => {
    const stub = stubServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completionResponse("Baik."));
    });
    const created = createTranslationProviderFromEnv({
      [TRANSLATE_API_KEY_ENV]: "REAL-OPERATOR-KEY-MUST-NOT-LEAVE",
      [TRANSLATE_ENDPOINT_ENV]: await stub.url(),
    });
    expect(created.isOk()).toBe(true);
    if (created.isErr()) {
      return;
    }
    const outcome = await created.value.translate(
      buildTranslationRequest(
        "Hello.",
        [],
        DEFAULT_TECHNICAL_GLOSSARY,
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
      createTranslationProviderFromEnv({ [TRANSLATE_ENDPOINT_ENV]: "http://127.0.0.1:9" }).isOk(),
    ).toBe(true);
    const missing = createTranslationProviderFromEnv({});
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
      }),
    ).toThrow();
    const created = createTranslationProviderFromEnv({
      [TRANSLATE_API_KEY_ENV]: "key",
      [TRANSLATE_ENDPOINT_ENV]: "https://evil.example.com/v1",
    });
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
          model: OPENAI_TRANSLATION_MODEL_ID,
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
    });
    const outcome = await provider.translate(
      buildTranslationRequest(
        "Hello.",
        [],
        DEFAULT_TECHNICAL_GLOSSARY,
        new AbortController().signal,
      ),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("makes exactly one attempt against a failing server", async () => {
    const stub = stubServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "boom" }));
    });
    const provider = createOpenAITranslationProvider({
      apiKey: "key",
      testEndpoint: await stub.url(),
    });
    const outcome = await provider.translate(
      buildTranslationRequest(
        "Hello.",
        [],
        DEFAULT_TECHNICAL_GLOSSARY,
        new AbortController().signal,
      ),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("INTERNAL");
    }
    expect(stub.requests.length).toBe(1);
  });

  it("fails a hanging request within its bound", async () => {
    const stub = stubServer(() => {
      throw new Error("must not respond");
    }, true);
    const provider = createOpenAITranslationProvider({
      apiKey: "key",
      testEndpoint: await stub.url(),
      timeoutMs: 100,
    });
    const started = Date.now();
    const outcome = await provider.translate(
      buildTranslationRequest(
        "Hello.",
        [],
        DEFAULT_TECHNICAL_GLOSSARY,
        new AbortController().signal,
      ),
    );
    expect(outcome.isErr()).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports cancellation without sending when already aborted", async () => {
    const stub = stubServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(completionResponse("x"));
    });
    const provider = createOpenAITranslationProvider({
      apiKey: "key",
      testEndpoint: await stub.url(),
    });
    const controller = new AbortController();
    controller.abort();
    const outcome = await provider.translate(
      buildTranslationRequest("Hello.", [], DEFAULT_TECHNICAL_GLOSSARY, controller.signal),
    );
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.code).toBe("CANCELLED");
    }
    expect(stub.requests.length).toBe(0);
  });
});
