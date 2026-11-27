import { appError, type AppError } from "@kernel/errors";
import {
  TranslationScheduler,
  type TranslationEvent,
  type TranslationProvider,
  type TranslationResult,
} from "@modules/language/translation";
import type { TranscriptEvent } from "@modules/perception/speech";
import * as fc from "fast-check";
import { err, ok, type Result } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeRequest {
  readonly userText: string;
  readonly priors: number;
}

function lastSourceBlock(userText: string): string {
  const open = userText.lastIndexOf("<source>");
  if (open === -1) {
    return userText;
  }
  const close = userText.indexOf("</source>", open);
  if (close === -1) {
    return userText;
  }
  return userText.slice(open + "<source>".length, close);
}

function fakeProvider(
  behavior: (request: FakeRequest) => Promise<Result<TranslationResult, AppError>> = async (
    request,
  ) => ok({ text: `ID: ${lastSourceBlock(request.userText)}` }),
): TranslationProvider & { readonly calls: FakeRequest[] } {
  const calls: FakeRequest[] = [];
  return {
    providerId: "fake",
    modelId: "fake-1",
    calls,
    translate: async (request) => {
      const userText = request.messages.find((message) => message.role === "user")?.content ?? "";
      const entry = { userText, priors: (userText.match(/<\/prior>/g) ?? []).length };
      calls.push(entry);
      return behavior(entry);
    },
  };
}

interface SleepGate {
  readonly promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

function manualSleeps(): { readonly gates: SleepGate[]; sleep: () => Promise<void> } {
  const gates: SleepGate[] = [];
  const sleep = (): Promise<void> => {
    const gate = deferred<void>();
    gates.push(gate);
    return gate.promise;
  };
  return { gates, sleep };
}

function partial(utteranceId: string, revision: number, text: string): TranscriptEvent {
  return { type: "partial", utteranceId, revision, text };
}

function final(utteranceId: string, revision: number, text: string): TranscriptEvent {
  return { type: "final", utteranceId, revision, text };
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("TranslationScheduler", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("emits a committed translation for a finalized utterance and reports English evidence untouched", async () => {
    const events: TranslationEvent[] = [];
    const scheduler = new TranslationScheduler({
      provider: fakeProvider(),
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
      sleep: async () => {},
    });
    await scheduler.consume(partial("u1", 0, "Do not deploy the service yet"));
    await scheduler.consume(final("u1", 1, "Do not deploy the service yet."));
    const summary = await scheduler.finish();
    expect(summary.committed).toBe(1);
    expect(summary.failed).toBe(false);
    const committed = events.filter((event) => event.type === "committed");
    expect(committed.length).toBe(1);
    if (committed[0]?.type === "committed") {
      expect(committed[0].unitId).toBe("tr:u1");
      expect(committed[0].sourceUtteranceIds).toEqual(["u1"]);
      expect(committed[0].fragment).toBe(false);
    }
  });

  it("supersedes in-flight provisionals and rejects stale responses", async () => {
    const events: TranslationEvent[] = [];
    const gate = deferred<Result<TranslationResult, AppError>>();
    const provider = fakeProvider(async () => gate.promise);
    const sleeps = manualSleeps();
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
      sleep: sleeps.sleep,
      debounceMs: 0,
    });
    await scheduler.consume(partial("u1", 0, "We should postpone the rollout until Friday"));
    expect(sleeps.gates.length).toBe(1);
    sleeps.gates[0]?.resolve();
    await flush();
    await flush();
    expect(provider.calls.length).toBe(1);
    await scheduler.consume(
      partial("u1", 1, "We should postpone the rollout until Friday morning"),
    );
    gate.resolve(ok({ text: "ID: stale" }));
    await flush();
    await flush();
    expect(events.filter((event) => event.type === "provisional").length).toBe(0);
    const summary = await scheduler.finish();
    expect(summary.staleRejected).toBe(1);
    expect(summary.requests).toBe(0);
  });

  it("never lets a late provisional overwrite a committed translation", async () => {
    const events: TranslationEvent[] = [];
    const gate = deferred<Result<TranslationResult, AppError>>();
    let releaseCommitted: ((value: Result<TranslationResult, AppError>) => void) | undefined;
    const provider = fakeProvider((request) => {
      void request;
      if (provider.calls.length === 1) {
        return gate.promise;
      }
      return new Promise<Result<TranslationResult, AppError>>((resolve) => {
        releaseCommitted = resolve;
      });
    });
    const sleeps = manualSleeps();
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
      sleep: sleeps.sleep,
      debounceMs: 0,
    });
    await scheduler.consume(partial("u1", 0, "Ship it after the migration is verified tonight"));
    sleeps.gates[0]?.resolve();
    await flush();
    await flush();
    await scheduler.consume(final("u1", 1, "Ship it after the migration is verified."));
    await flush();
    gate.resolve(ok({ text: "ID: late provisional" }));
    await flush();
    await flush();
    releaseCommitted?.(ok({ text: "ID final." }));
    const summary = await scheduler.finish();
    const committed = events.filter((event) => event.type === "committed");
    const provisionals = events.filter((event) => event.type === "provisional");
    expect(committed.length).toBe(1);
    expect(provisionals.length).toBe(0);
    expect(summary.staleRejected).toBe(1);
  });

  it("keeps identical source text in separate utterances distinct", async () => {
    const events: TranslationEvent[] = [];
    const scheduler = new TranslationScheduler({
      provider: fakeProvider(),
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
      sleep: async () => {},
    });
    await scheduler.consume(final("u1", 0, "Deploy on Friday."));
    await scheduler.consume(final("u2", 0, "Deploy on Friday."));
    await scheduler.finish();
    const committed = events.filter((event) => event.type === "committed");
    expect(committed.length).toBe(2);
    const units = new Set(
      committed.map((event) => (event.type === "committed" ? event.unitId : "")),
    );
    expect(units).toEqual(new Set(["tr:u1", "tr:u2"]));
  });

  it("bounds requests when partials arrive faster than the provider", async () => {
    const provider = fakeProvider(
      async () => deferred<Result<TranslationResult, AppError>>().promise,
    );
    const sleeps = manualSleeps();
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async () => {},
      sleep: sleeps.sleep,
      debounceMs: 0,
      minNewWords: 1,
    });
    for (let revision = 0; revision < 50; revision += 1) {
      await scheduler.consume(partial("u1", revision, `word${revision} alpha beta gamma delta`));
    }
    for (const gate of sleeps.gates) {
      gate.resolve();
    }
    await flush();
    await flush();
    expect(provider.calls.length).toBeLessThanOrEqual(2);
    const summary = await scheduler.finish();
    expect(summary.requests).toBe(0);
    expect(provider.calls.length).toBeLessThanOrEqual(2);
  });

  it("degrades explicitly when committed work exceeds its bound", async () => {
    const events: TranslationEvent[] = [];
    const gates: Deferred<Result<TranslationResult, AppError>>[] = [];
    const provider = fakeProvider(() => {
      const gate = deferred<Result<TranslationResult, AppError>>();
      gates.push(gate);
      return gate.promise;
    });
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
      sleep: async () => {},
      maxPendingCommitted: 2,
    });
    await scheduler.consume(final("u1", 0, "First sentence here."));
    await scheduler.consume(final("u2", 0, "Second sentence here."));
    await scheduler.consume(final("u3", 0, "Third sentence here."));
    await scheduler.consume(final("u4", 0, "Fourth sentence here."));
    expect(provider.calls.length).toBe(1);
    gates[0]?.resolve(ok({ text: "ID: one." }));
    await flush();
    await flush();
    expect(provider.calls.length).toBe(2);
    gates[1]?.resolve(ok({ text: "ID: two." }));
    await flush();
    await flush();
    expect(provider.calls.length).toBe(3);
    gates[2]?.resolve(ok({ text: "ID: three." }));
    const summary = await scheduler.finish();
    expect(summary.committed).toBe(3);
    expect(summary.degraded).toBe(1);
    expect(
      events.some((event) => event.type === "degraded" && event.reason === "backlog-overflow"),
    ).toBe(true);
    expect(provider.calls.length).toBe(3);
  });

  it("reports provider failure without failing the transcription", async () => {
    const events: TranslationEvent[] = [];
    const scheduler = new TranslationScheduler({
      provider: fakeProvider(async () => err(appError("INTERNAL", "translation request failed"))),
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
      sleep: async () => {},
    });
    await scheduler.consume(final("u1", 0, "Deploy on Friday."));
    const summary = await scheduler.finish();
    expect(summary.committed).toBe(0);
    expect(summary.degraded).toBe(1);
    expect(summary.failed).toBe(false);
    expect(
      events.some((event) => event.type === "degraded" && event.reason === "provider-failed"),
    ).toBe(true);
  });

  it("rejects empty model output instead of committing it", async () => {
    const events: TranslationEvent[] = [];
    const scheduler = new TranslationScheduler({
      provider: fakeProvider(async () => ok({ text: "   " })),
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
      sleep: async () => {},
    });
    await scheduler.consume(final("u1", 0, "Deploy on Friday."));
    const summary = await scheduler.finish();
    expect(summary.committed).toBe(0);
    expect(
      events.some((event) => event.type === "degraded" && event.reason === "validation-failed"),
    ).toBe(true);
  });

  it("marks incomplete source as a fragment and stops bridging across gaps", async () => {
    const seen: FakeRequest[] = [];
    const events: TranslationEvent[] = [];
    const scheduler = new TranslationScheduler({
      provider: fakeProvider(async (request) => {
        seen.push(request);
        return ok({ text: `ID: ${lastSourceBlock(request.userText)}` });
      }),
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
      sleep: async () => {},
    });
    await scheduler.consume(final("u1", 0, "The migration runs tonight."));
    await scheduler.consume({ type: "discontinuity", reason: "capture-gap", detail: "test gap" });
    await scheduler.consume(final("u2", 0, "Ship it after verification"));
    const summary = await scheduler.finish();
    expect(summary.committed).toBe(2);
    const second = seen[seen.length - 1];
    expect(second?.priors).toBe(0);
    const fragments = events.filter((event) => event.type === "committed" && event.fragment);
    expect(fragments.length).toBe(1);
  });

  it("passes bounded recent source context and glossary-shaped prompts", async () => {
    const seen: FakeRequest[] = [];
    const scheduler = new TranslationScheduler({
      provider: fakeProvider(async (request) => {
        seen.push(request);
        return ok({ text: `ID: ${lastSourceBlock(request.userText)}` });
      }),
      signal: new AbortController().signal,
      onEvent: async () => {},
      sleep: async () => {},
      maxContextUtterances: 2,
    });
    for (let index = 0; index < 6; index += 1) {
      await scheduler.consume(final(`u${index}`, 0, `Sentence number ${index} here.`));
    }
    await scheduler.finish();
    const last = seen[seen.length - 1];
    expect((last?.priors ?? 99) <= 2).toBe(true);
    expect(last?.userText.includes("Sentence number 0 here.")).toBe(false);
  });

  it("keeps committed output consistent under arbitrary event sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            utterance: fc.integer({ min: 0, max: 2 }),
            revision: fc.integer({ min: 0, max: 4 }),
            text: fc
              .string({ minLength: 1, maxLength: 24 })
              .filter((text) => text.trim().length > 0),
            kind: fc.constantFrom("partial", "final"),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        async (operations) => {
          const events: TranslationEvent[] = [];
          const scheduler = new TranslationScheduler({
            provider: fakeProvider(),
            signal: new AbortController().signal,
            onEvent: async (event) => {
              events.push(event);
            },
            sleep: async () => {},
          });
          const finalized = new Set<string>();
          for (const operation of operations) {
            const utteranceId = `u${operation.utterance}`;
            if (operation.kind === "partial") {
              await scheduler.consume(partial(utteranceId, operation.revision, operation.text));
            } else {
              await scheduler.consume(final(utteranceId, operation.revision, `${operation.text}.`));
              finalized.add(utteranceId);
            }
          }
          const summary = await scheduler.finish();
          const committed = events.filter((event) => event.type === "committed");
          const committedUnits = committed.map((event) =>
            event.type === "committed" ? event.unitId : "",
          );
          expect(new Set(committedUnits).size).toBe(committedUnits.length);
          for (const unitId of committedUnits) {
            expect(finalized.has(unitId.replace(/^tr:/, ""))).toBe(true);
          }
          expect(summary.committed).toBe(committed.length);
          for (const event of events) {
            if (event.type === "provisional") {
              expect(event.text.trim().length).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it("cancels pending work without issuing new requests", async () => {
    const provider = fakeProvider();
    const controller = new AbortController();
    const sleeps = manualSleeps();
    const scheduler = new TranslationScheduler({
      provider,
      signal: controller.signal,
      onEvent: async () => {},
      sleep: sleeps.sleep,
      debounceMs: 0,
    });
    await scheduler.consume(partial("u1", 0, "We should postpone the rollout until Friday"));
    controller.abort();
    for (const gate of sleeps.gates) {
      gate.resolve();
    }
    const summary = await scheduler.finish();
    expect(provider.calls.length).toBe(0);
    expect(summary.requests).toBe(0);
  });
});
