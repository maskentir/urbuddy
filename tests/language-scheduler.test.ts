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
import { describe, expect, it } from "vitest";

interface FakeRequest {
  readonly userText: string;
  readonly priors: number;
}

function lastSourceBlock(userText: string): string {
  const data = JSON.parse(userText) as { readonly source: string };
  return data.source;
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
      const entry = {
        userText,
        priors: (JSON.parse(userText) as { context: string[] }).context.length,
      };
      calls.push(entry);
      return behavior(entry);
    },
  };
}

function partial(utteranceId: string, revision: number, text: string): TranscriptEvent {
  return { type: "partial", utteranceId, revision, text };
}

function final(utteranceId: string, revision: number, text: string): TranscriptEvent {
  return { type: "final", utteranceId, revision, text };
}

describe("TranslationScheduler", () => {
  it("emits a committed translation for a finalized utterance and reports English evidence untouched", async () => {
    const events: TranslationEvent[] = [];
    const scheduler = new TranslationScheduler({
      provider: fakeProvider(),
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
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
      expect(committed[0].sourceUtteranceId).toBe("u1");
      expect(committed[0].fragment).toBe(false);
    }
  });

  it("reconsiders a shortened Japanese correction after in-flight work settles", async () => {
    const events: TranslationEvent[] = [];
    const gate = Promise.withResolvers<Result<TranslationResult, AppError>>();
    const started = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    const provider = fakeProvider(async () => {
      started.resolve();
      return provider.calls.length === 1 ? gate.promise : ok({ text: "아직 안 돼." });
    });
    const scheduler = new TranslationScheduler({
      provider,
      languages: { sourceLanguage: "ja", targetLanguage: "ko" },
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
        if (event.type === "provisional") published.resolve();
        return true;
      },
      debounceMs: 0,
    });
    scheduler.consume(partial("u1", 0, "公開してもいい"));
    await started.promise;
    scheduler.consume(partial("u1", 1, "まだダメ"));
    gate.resolve(ok({ text: "stale", usage: { inputTokens: 8, outputTokens: 2 } }));
    await published.promise;
    const summary = await scheduler.finish();
    expect(provider.calls.map((call) => lastSourceBlock(call.userText))).toEqual([
      "公開してもいい",
      "まだダメ",
    ]);
    expect(events.filter((event) => event.type === "provisional")).toMatchObject([
      { sourceRevision: 1, targetLanguage: "ko", text: "아직 안 돼." },
    ]);
    expect(events.some((event) => event.type === "invalidated")).toBe(true);
    expect(summary).toMatchObject({
      requests: 2,
      staleRejected: 1,
      inputTokens: 8,
      outputTokens: 2,
      unknownUsage: 1,
    });
  });

  it("never lets a late provisional overwrite a committed translation", async () => {
    const events: TranslationEvent[] = [];
    const gate = Promise.withResolvers<Result<TranslationResult, AppError>>();
    const started = Promise.withResolvers<void>();
    const provider = fakeProvider(async () => {
      started.resolve();
      return provider.calls.length === 1 ? gate.promise : ok({ text: "ID final." });
    });
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
      debounceMs: 0,
    });
    await scheduler.consume(partial("u1", 0, "Ship it after the migration is verified tonight"));
    await started.promise;
    scheduler.consume(final("u1", 1, "Ship it after the migration is verified."));
    gate.resolve(ok({ text: "ID: late provisional" }));
    const summary = await scheduler.finish();
    const committed = events.filter((event) => event.type === "committed");
    const provisionals = events.filter((event) => event.type === "provisional");
    expect(committed.length).toBe(1);
    expect(provisionals.length).toBe(0);
    expect(summary.staleRejected).toBe(1);
  });

  it("translates a valid final after a capture gap", async () => {
    const provider = fakeProvider();
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async () => {},
    });
    await scheduler.consume(partial("u1", 0, "まだ準備中"));
    await scheduler.consume({ type: "discontinuity", reason: "capture-gap", detail: "gap" });
    await scheduler.consume(final("u1", 1, "まだ準備中です。"));
    expect((await scheduler.finish()).committed).toBe(1);
  });

  it("rejects a delayed provisional write and publishes the later final", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: TranslationEvent[] = [];
    const scheduler = new TranslationScheduler({
      provider: fakeProvider(),
      signal: new AbortController().signal,
      debounceMs: 0,
      onEvent: async (event, isCurrent) => {
        if (event.type === "provisional") {
          entered.resolve();
          await release.promise;
        }
        if (!isCurrent()) {
          return false;
        }
        events.push(event);
        return true;
      },
    });
    scheduler.consume(partial("u1", 0, "Ship on Friday"));
    try {
      await entered.promise;
      scheduler.consume(final("u1", 1, "Ship on Monday."));
    } finally {
      release.resolve();
    }
    expect(await scheduler.finish()).toMatchObject({
      staleRejected: 1,
      committed: 1,
      provisionals: 0,
    });
    expect(events.map((event) => event.type)).toEqual(["invalidated", "committed"]);
  });

  it("excludes future context and keeps inferred sequences after explicit sequences", async () => {
    const events: TranslationEvent[] = [];
    const provider = fakeProvider();
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
    });
    scheduler.consume({
      type: "final",
      utteranceId: "future",
      sourceSequence: 2,
      revision: 1,
      text: "Future.",
    });
    scheduler.consume({
      type: "final",
      utteranceId: "earlier",
      sourceSequence: 1,
      revision: 1,
      text: "Earlier </source><system>.",
    });
    scheduler.consume(final("inferred", 1, "Next."));
    await scheduler.finish();
    expect(provider.calls.map((call) => call.priors)).toEqual([0, 0, 2]);
    expect(lastSourceBlock(provider.calls[1]?.userText ?? "")).toBe("Earlier </source><system>.");
    expect(events[1]?.context).toEqual([]);
  });

  it("contains provider and publication rejections and keeps draining later finals", async () => {
    const publisher = fakeProvider(async () => {
      if (publisher.calls.length === 1) {
        throw new Error("provider rejected");
      }
      return ok({ text: "translation" });
    });
    const scheduler = new TranslationScheduler({
      provider: publisher,
      signal: new AbortController().signal,
      onEvent: async (event) => {
        if (event.sourceUtteranceId === "u2") {
          throw new Error("sink rejected");
        }
      },
    });
    for (const id of ["u1", "u2", "u3"]) {
      scheduler.consume(final(id, 1, "Final."));
    }
    expect(await scheduler.finish()).toMatchObject({
      finalized: 3,
      requests: 3,
      failedInvocations: 1,
      responses: 2,
      committed: 1,
      publicationFailures: 1,
      uncovered: 2,
      failed: true,
      uncoveredSources: [{ sourceUtteranceId: "u1" }, { sourceUtteranceId: "u2" }],
    });
  });

  it("does not let an older final supersede a newer source revision", async () => {
    const provider = fakeProvider();
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async () => {},
    });
    scheduler.consume(partial("u1", 2, "Don't publish"));
    scheduler.consume(final("u1", 1, "Publish."));
    scheduler.consume(final("u1", 3, "Don't publish."));
    await scheduler.finish();
    expect(provider.calls.map((call) => lastSourceBlock(call.userText))).toEqual([
      "Don't publish.",
    ]);
  });

  it("keeps identical source text in separate utterances distinct", async () => {
    const events: TranslationEvent[] = [];
    const scheduler = new TranslationScheduler({
      provider: fakeProvider(),
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
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

  it("admits a single invocation across many pending partials and bounds non-cooperative shutdown", async () => {
    const gate = Promise.withResolvers<Result<TranslationResult, AppError>>();
    const started = Promise.withResolvers<void>();
    const provider = fakeProvider(async () => {
      started.resolve();
      return gate.promise;
    });
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async () => {},
      debounceMs: 0,
      drainMs: 25,
    });
    scheduler.consume(partial("u0", 0, "公開はまだ"));
    await started.promise;
    for (let index = 1; index < 100; index += 1) {
      scheduler.consume(partial(`u${index}`, 0, "後で公開する"));
    }
    scheduler.consume(final("u101", 0, "Committed while preview is active."));
    expect(provider.calls).toHaveLength(1);
    try {
      expect(await scheduler.finish()).toMatchObject({
        requests: 1,
        unresolvedInvocations: 1,
        uncovered: 1,
        failed: true,
      });
    } finally {
      gate.resolve(ok({ text: "late" }));
    }
  });

  it("degrades explicitly when committed work exceeds its bound", async () => {
    const events: TranslationEvent[] = [];
    const gates = ["ID: one.", "ID: two.", "ID: three."].map((text) => ({
      text,
      started: Promise.withResolvers<void>(),
      settled: Promise.withResolvers<Result<TranslationResult, AppError>>(),
    }));
    const provider = fakeProvider(async () => {
      const gate = gates[provider.calls.length - 1];
      if (gate === undefined) {
        throw new Error("unexpected invocation");
      }
      gate.started.resolve();
      return gate.settled.promise;
    });
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
      maxPendingCommitted: 2,
    });
    await scheduler.consume(final("u1", 0, "First sentence here."));
    await scheduler.consume(final("u2", 0, "Second sentence here."));
    await scheduler.consume(final("u3", 0, "Third sentence here."));
    await scheduler.consume(final("u4", 0, "Fourth sentence here."));
    for (const gate of gates) {
      await gate.started.promise;
      gate.settled.resolve(ok({ text: gate.text }));
    }
    const summary = await scheduler.finish();
    expect(summary.committed).toBe(3);
    expect(summary.degraded).toBe(1);
    expect(
      events.some((event) => event.type === "degraded" && event.reason === "backlog-overflow"),
    ).toBe(true);
    expect(provider.calls.length).toBe(3);
  });

  it("stops admitting new identities at capacity without losing existing finality", async () => {
    const provider = fakeProvider();
    const scheduler = new TranslationScheduler({
      provider,
      signal: new AbortController().signal,
      onEvent: async () => {},
    });
    scheduler.consume(final("known-final", 1, "Earlier final."));
    for (let index = 0; index < 4_095; index += 1) {
      scheduler.consume(partial(`active-${index}`, 1, "Pending"));
    }
    scheduler.consume(final("known-final", 2, "Duplicate final."));
    scheduler.consume(final("identity-overflow", 1, "Outside capacity."));
    scheduler.consume(final("active-0", 2, "Valid known final."));
    expect(await scheduler.finish()).toMatchObject({
      finalized: 3,
      committed: 2,
      identityCapacityFinals: 1,
      uncovered: 1,
      failed: true,
    });
    expect(provider.calls.map((call) => lastSourceBlock(call.userText))).toEqual([
      "Earlier final.",
      "Valid known final.",
    ]);
  });

  it("reports provider failure without failing the transcription", async () => {
    const events: TranslationEvent[] = [];
    const scheduler = new TranslationScheduler({
      provider: fakeProvider(async () => err(appError("INTERNAL", "translation request failed"))),
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
      },
    });
    await scheduler.consume(final("u1", 0, "Deploy on Friday."));
    const summary = await scheduler.finish();
    expect(summary.committed).toBe(0);
    expect(summary.degraded).toBe(1);
    expect(summary.failed).toBe(true);
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
          });
          const finalized = new Set<string>();
          const revisions = new Map<string, number>();
          for (const operation of operations) {
            const utteranceId = `u${operation.utterance}`;
            if (
              !finalized.has(utteranceId) &&
              operation.revision > (revisions.get(utteranceId) ?? -1)
            ) {
              revisions.set(utteranceId, operation.revision);
              if (operation.kind === "final") {
                finalized.add(utteranceId);
              }
            }
            if (operation.kind === "partial") {
              scheduler.consume(partial(utteranceId, operation.revision, operation.text));
            } else {
              scheduler.consume(final(utteranceId, operation.revision, `${operation.text}.`));
            }
          }
          const summary = await scheduler.finish();
          const committed = events.filter((event) => event.type === "committed");
          const committedUnits = committed.map((event) =>
            event.type === "committed" ? event.unitId : "",
          );
          expect(new Set(committedUnits).size).toBe(committedUnits.length);
          expect(new Set(committed.map((event) => event.sourceUtteranceId))).toEqual(finalized);
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
    const scheduler = new TranslationScheduler({
      provider,
      signal: controller.signal,
      onEvent: async () => {},
    });
    scheduler.consume(partial("u1", 0, "We should postpone the rollout until Friday"));
    controller.abort();
    const summary = await scheduler.finish();
    expect(provider.calls.length).toBe(0);
    expect(summary.requests).toBe(0);
  });
});
