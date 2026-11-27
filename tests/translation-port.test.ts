import { appError, type AppError } from "@kernel/errors";
import type { TranslationProvider } from "@modules/language/translation";
import type { CaptureSource, SourceItem } from "@modules/perception/audio";
import type {
  SpeechProvider,
  SpeechProviderEvent,
  SpeechSession,
} from "@modules/perception/speech";
import { createTranscribePort } from "@presentation/transcribe";
import { err, ok, type Result } from "neverthrow";
import { describe, expect, it } from "vitest";

function wavSource(): CaptureSource {
  return {
    async *items(): AsyncIterable<SourceItem> {
      yield { type: "format", seq: 0, format: { sampleRate: 24_000, channels: 1 } };
      yield {
        type: "audio",
        chunk: { seq: 1, startSample: 0, samples: new Float32Array(480).fill(0.1) },
      };
      yield {
        type: "end",
        seq: 2,
        end: {
          captured: 1,
          delivered: 1,
          dropped: 0,
          reason: "completed",
          sourceFrames: 480,
        },
      };
    },
    async stop(): Promise<void> {},
    async dispose(): Promise<Result<void, AppError>> {
      return ok(undefined);
    },
  };
}

function scriptedSession(events: SpeechProviderEvent[]): SpeechSession {
  return {
    encoding: "PCM_24KHZ",
    providerSessionId: "fake-session",
    async *events(): AsyncIterable<SpeechProviderEvent> {
      for (const event of events) {
        yield event;
      }
    },
    async sendAudio(): Promise<Result<void, AppError>> {
      return ok(undefined);
    },
    async endInput(): Promise<Result<void, AppError>> {
      return ok(undefined);
    },
    async terminate(): Promise<Result<void, AppError>> {
      return ok(undefined);
    },
  };
}

function fakeSpeech(events: SpeechProviderEvent[]): SpeechProvider {
  return {
    providerId: "fake-stt",
    modelId: "fake-stt-1",
    openSession: async () => ok(scriptedSession(events)),
  };
}

function lastSourceBlock(userText: string): string {
  const data = JSON.parse(userText) as { readonly source: string };
  return data.source;
}

function echoTranslator(): TranslationProvider {
  return {
    providerId: "fake",
    modelId: "fake-1",
    translate: async (request) => {
      const userText = request.messages.find((message) => message.role === "user")?.content ?? "";
      const source = lastSourceBlock(userText);
      return ok({ text: `ID: ${source}` });
    },
  };
}

function failingTranslator(): TranslationProvider {
  return {
    providerId: "fake",
    modelId: "fake-1",
    translate: async () =>
      err(
        appError("INTERNAL", "translation request failed", {
          details: { provider: "fixture", category: "transport" },
        }),
      ),
  };
}

describe("transcribe port with translation", () => {
  it("emits bilingual output while keeping English evidence intact", async () => {
    const lines: string[] = [];
    const errLines: string[] = [];
    const port = createTranscribePort({
      clock: { now: () => 0, isoNow: () => "" },
      loopbackEndpoint: false,
      translationLoopbackEndpoint: false,
      createProvider: () =>
        ok(
          fakeSpeech([
            { type: "partial", turnRef: "t1", text: "Do not deploy", audioProcessedMs: 100 },
            {
              type: "completed",
              turnRef: "t1",
              text: "Do not deploy it yet.",
              audioProcessedMs: 200,
            },
          ]),
        ),
      createTranslator: () => ok(echoTranslator()),
      openWav: async () => ok(wavSource()),
    });
    const outcome = await port({
      file: "input.wav",
      mode: "endpointing",
      keywords: [],
      json: false,
      translate: true,
      signal: new AbortController().signal,
      output: {
        out: async (line: string) => {
          lines.push(line);
        },
        errLine: async (line: string) => {
          errLines.push(line);
        },
      },
    });
    expect(outcome.isOk()).toBe(true);
    expect(lines.some((line) => line.includes("[partial] Do not deploy"))).toBe(true);
    expect(outcome.isOk() && outcome.value.translation).toMatchObject({
      requests: 1,
      finalized: 1,
      committed: 1,
      provisionals: 0,
      unresolvedInvocations: 0,
      unresolvedPublication: false,
    });
    expect(lines.some((line) => line.includes("[final] Do not deploy it yet."))).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.startsWith("[translation committed auto → id ") &&
          line.endsWith("ID: Do not deploy it yet."),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes("translation complete: committed=1/1"))).toBe(true);
    expect(
      errLines.some((line) => line.includes("transcript text and recent context will be sent")),
    ).toBe(true);
    if (outcome.isOk() && outcome.value.translation !== undefined) {
      expect(outcome.value.translation.committed).toBe(1);
      expect(outcome.value.translation.failed).toBe(false);
    } else {
      expect.unreachable();
    }
  });

  it.each([
    { sourceLanguage: "bad_tag" },
    { targetLanguage: "auto" },
    { translationProvider: "unsupported" },
    { translationModel: "unavailable-model" },
  ])(
    "rejects invalid translation configuration before speech construction or WAV acquisition: %j",
    async (translationFlags) => {
      let speechConstructed = false;
      let wavOpened = false;
      const port = createTranscribePort({
        clock: { now: () => 0, isoNow: () => "" },
        loopbackEndpoint: false,
        translationLoopbackEndpoint: false,
        createProvider: () => {
          speechConstructed = true;
          return ok(fakeSpeech([]));
        },
        createTranslator: () => err(appError("CONFIG_INVALID", "unsupported translation model")),
        openWav: async () => {
          wavOpened = true;
          return ok(wavSource());
        },
      });
      const outcome = await port({
        file: "input.wav",
        mode: "endpointing",
        keywords: [],
        json: true,
        translate: true,
        translationFlags,
        signal: new AbortController().signal,
        output: { out: () => {}, errLine: () => {} },
      });
      expect(outcome.isErr() && outcome.error.code).toBe("CONFIG_INVALID");
      expect(speechConstructed).toBe(false);
      expect(wavOpened).toBe(false);
    },
  );

  it.each([
    { speech: false, translation: true, file: "input.wav" },
    { speech: true, translation: false, file: "input.wav" },
    { speech: true, translation: true },
  ])("denies mixed endpoints and native capture before provider creation: %j", async (options) => {
    let providerCreations = 0;
    const port = createTranscribePort({
      clock: { now: () => 0, isoNow: () => "" },
      loopbackEndpoint: options.speech,
      translationLoopbackEndpoint: options.translation,
      createProvider: () => {
        providerCreations += 1;
        return ok(fakeSpeech([]));
      },
      createTranslator: () => {
        providerCreations += 1;
        return ok(echoTranslator());
      },
    });
    const outcome = await port({
      ...("file" in options ? { file: options.file } : {}),
      mode: "endpointing",
      keywords: [],
      json: true,
      translate: true,
      signal: new AbortController().signal,
      output: { out: () => {}, errLine: () => {} },
    });
    expect(outcome.isErr() && outcome.error.code).toBe("CONFIG_INVALID");
    expect(providerCreations).toBe(0);
  });

  it("keeps STT-only runs working without a translator", async () => {
    const lines: string[] = [];
    const port = createTranscribePort({
      clock: { now: () => 0, isoNow: () => "" },
      loopbackEndpoint: false,
      translationLoopbackEndpoint: false,
      createProvider: () =>
        ok(
          fakeSpeech([
            { type: "completed", turnRef: "t1", text: "Deploy on Friday.", audioProcessedMs: 100 },
          ]),
        ),
      openWav: async () => ok(wavSource()),
    });
    const outcome = await port({
      file: "input.wav",
      mode: "endpointing",
      keywords: [],
      json: false,
      translate: false,
      signal: new AbortController().signal,
      output: {
        out: async (line: string) => {
          lines.push(line);
        },
        errLine: async () => {},
      },
    });
    expect(outcome.isOk()).toBe(true);
    expect(lines.some((line) => line.includes("[translation"))).toBe(false);
  });

  it("refuses translation without egress wiring before acquiring the source", async () => {
    let opened = false;
    const port = createTranscribePort({
      clock: { now: () => 0, isoNow: () => "" },
      loopbackEndpoint: false,
      translationLoopbackEndpoint: false,
      openWav: async () => {
        opened = true;
        return ok(wavSource());
      },
    });
    const outcome = await port({
      file: "input.wav",
      mode: "endpointing",
      keywords: [],
      json: false,
      translate: true,
      signal: new AbortController().signal,
      output: { out: async () => {}, errLine: async () => {} },
    });
    expect(outcome.isErr()).toBe(true);
    expect(opened).toBe(false);
  });

  it("surfaces translator creation failure without starting transcription", async () => {
    let opened = false;
    const port = createTranscribePort({
      clock: { now: () => 0, isoNow: () => "" },
      loopbackEndpoint: false,
      translationLoopbackEndpoint: false,
      createProvider: () => ok(fakeSpeech([])),
      createTranslator: () =>
        err(appError("CONFIG_INVALID", "translation credential is not configured")),
      openWav: async () => {
        opened = true;
        return ok(wavSource());
      },
    });
    const outcome = await port({
      file: "input.wav",
      mode: "endpointing",
      keywords: [],
      json: false,
      translate: true,
      signal: new AbortController().signal,
      output: { out: async () => {}, errLine: async () => {} },
    });
    expect(outcome.isErr()).toBe(true);
    expect(opened).toBe(false);
  });

  it("degrades honestly when translation fails while transcription succeeds", async () => {
    const lines: string[] = [];
    const port = createTranscribePort({
      clock: { now: () => 0, isoNow: () => "" },
      loopbackEndpoint: false,
      translationLoopbackEndpoint: false,
      createProvider: () =>
        ok(
          fakeSpeech([
            { type: "completed", turnRef: "t1", text: "Deploy on Friday.", audioProcessedMs: 100 },
          ]),
        ),
      createTranslator: () => ok(failingTranslator()),
      openWav: async () => ok(wavSource()),
    });
    const outcome = await port({
      file: "input.wav",
      mode: "endpointing",
      keywords: [],
      json: true,
      translate: true,
      signal: new AbortController().signal,
      output: {
        out: async (line: string) => {
          lines.push(line);
        },
        errLine: async () => {},
      },
    });
    expect(outcome.isOk()).toBe(true);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        type: "degraded",
        details: { provider: "fixture", category: "transport" },
      }),
    );
    if (outcome.isOk() && outcome.value.translation !== undefined) {
      expect(outcome.value.translation.committed).toBe(0);
      expect(outcome.value.translation.degraded).toBe(1);
    } else {
      expect.unreachable();
    }
  });
});
