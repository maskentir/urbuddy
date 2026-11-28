import { TranslationScheduler, type TranslationEvent } from "@modules/language/translation";
import { CaptionHistory } from "@modules/session/captions";
import { acceptedTranscript, type StreamEvent } from "@modules/session/events";
import { SessionAdmission } from "@modules/session/runtime";
import { ok } from "neverthrow";
import { expect, test } from "vitest";

const languages = { sourceLanguage: "en", targetLanguage: "id" };

function line(seq: number, changes: Partial<StreamEvent> = {}): StreamEvent {
  return {
    sessionId: "session",
    streamId: "speech",
    seq,
    utteranceId: "turn-1",
    revision: 1,
    kind: "final",
    text: "Hold crate nineteen.",
    ...changes,
  };
}

function translation(revision: number, text: string): TranslationEvent {
  return {
    type: "committed",
    operationId: "operation",
    unitId: "unit",
    sourceUtteranceId: "turn-1",
    sourceRevision: revision,
    ...languages,
    providerId: "loopback",
    modelId: "fixture",
    promptVersion: "fixture",
    context: [],
    coverageUncertain: false,
    text,
    fragment: false,
    sourceArrivedMs: 0,
    queueMs: 0,
    responseMs: 0,
    publicationMs: 0,
  };
}

test("only the admitted source yields a translation request", async () => {
  const admission = new SessionAdmission();
  const requests: string[] = [];
  const scheduler = new TranslationScheduler({
    provider: {
      providerId: "loopback",
      modelId: "fixture",
      translate: async (request) => {
        requests.push(request.messages[1]?.content ?? "");
        return ok({ text: "Tahan peti sembilan belas." });
      },
    },
    languages,
    signal: new AbortController().signal,
    onEvent: async () => undefined,
  });
  const admit = (event: StreamEvent): string => {
    const { output } = admission.accept(event);
    if (output.isErr()) return output.error.code;
    const source = acceptedTranscript(output.value, {
      type: event.kind,
      utteranceId: event.utteranceId,
      revision: event.revision,
      text: event.text,
    });
    if (source !== undefined) scheduler.consume(source);
    return output.value.type;
  };

  expect(admit(line(0))).toBe("applied");
  expect(admit(line(0))).toBe("duplicate");
  expect(admit(line(1, { revision: 0 }))).toBe("stale");
  expect(admit(line(2, { sessionId: "other" }))).toBe("VALIDATION_FAILED");
  const summary = await scheduler.finish();
  expect(summary).toMatchObject({ requests: 1, committed: 1 });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("Hold crate nineteen.");
});

test("older or repeated publications leave the current caption and source intact", () => {
  const admission = new SessionAdmission();
  const captions = new CaptionHistory(true);
  const { output } = admission.accept(line(0, { revision: 2 }));
  if (output.isErr()) throw output.error;
  captions.accept(output.value, 0);
  expect(captions.snapshot().rows[0]?.translation.state).toBe("pending");
  captions.publish(translation(1, "Stale"));
  captions.publish(translation(2, "Tahan peti sembilan belas."));
  captions.publish(translation(2, "Conflicting duplicate"));
  captions.publish({ ...translation(1, "unused"), type: "degraded", reason: "provider-failed" });
  expect(captions.snapshot().rows).toEqual([
    expect.objectContaining({
      text: "Hold crate nineteen.",
      revision: 2,
      translation: { state: "committed", text: "Tahan peti sembilan belas.", uncertain: false },
    }),
  ]);
});

test("caption history evicts older rows and finishes pending work honestly", () => {
  const admission = new SessionAdmission();
  const captions = new CaptionHistory(true);
  for (let seq = 0; seq < 130; seq += 1) {
    const { output } = admission.accept(line(seq, { utteranceId: `turn-${seq}` }));
    if (output.isErr()) throw output.error;
    captions.accept(output.value, seq);
  }
  captions.gap("capture gap");
  captions.setStatus("completed");
  const snapshot = captions.snapshot();
  expect(snapshot).toMatchObject({ dropped: 10, gaps: 1, lastGap: "capture gap" });
  expect(snapshot.rows).toHaveLength(120);
  expect(snapshot.rows[0]?.id).toBe("turn-10");
  expect(snapshot.rows.every((row) => row.translation.state === "failed")).toBe(true);
});
