import { TranscriptReducer, type SpeechProviderEvent } from "@modules/perception/speech";
import { describe, expect, it } from "vitest";

function applyAll(
  reducer: TranscriptReducer,
  events: readonly SpeechProviderEvent[],
): ReturnType<TranscriptReducer["apply"]>[] {
  return events.map((event) => reducer.apply(event));
}

describe("TranscriptReducer", () => {
  it("replaces cumulative partials and counts revisions", () => {
    const reducer = new TranscriptReducer();
    const results = applyAll(reducer, [
      { type: "connectionEpoch", epoch: 0, uncertainMs: 0 },
      { type: "turnStarted", turnRef: "1" },
      { type: "partial", text: "how is" },
      { type: "partial", text: "how is the" },
      { type: "partial", text: "how is" },
    ]);
    const partials = results.flatMap((r) => (r.isOk() && r.value !== undefined ? [r.value] : []));
    expect(partials.map((p) => (p.type === "partial" ? p.revision : -1))).toEqual([1, 2, 3]);
    expect(reducer.partialCount).toBe(3);
  });

  it("keeps overlapping turns distinct and attaches late finals to their turn", () => {
    const reducer = new TranscriptReducer();
    reducer.apply({ type: "connectionEpoch", epoch: 0, uncertainMs: 0 });
    reducer.apply({ type: "turnStarted", turnRef: "1" });
    reducer.apply({ type: "partial", text: "first" });
    reducer.apply({ type: "turnStarted", turnRef: "2" });
    reducer.apply({ type: "partial", text: "second" });
    const late = reducer.apply({ type: "completed", turnRef: "1", text: "First done." });
    const second = reducer.apply({ type: "completed", turnRef: "2", text: "Second done." });
    expect(late.isOk() && late.value?.type === "final" && late.value.text).toBe("First done.");
    expect(second.isOk() && second.value?.type === "final" && second.value.text).toBe(
      "Second done.",
    );
    if (late.isOk() && second.isOk() && late.value && second.value) {
      expect(
        late.value.type === "final" && second.value.type === "final"
          ? late.value.utteranceId !== second.value.utteranceId
          : false,
      ).toBe(true);
    }
  });

  it("keeps distinct occurrences with identical text distinct", () => {
    const reducer = new TranscriptReducer();
    reducer.apply({ type: "connectionEpoch", epoch: 0, uncertainMs: 0 });
    const first = reducer.apply({ type: "completed", turnRef: "1", text: "same words" });
    const second = reducer.apply({ type: "completed", turnRef: "2", text: "same words" });
    expect(reducer.finalCount).toBe(2);
    if (
      first.isOk() &&
      second.isOk() &&
      first.value?.type === "final" &&
      second.value?.type === "final"
    ) {
      expect(first.value.utteranceId).not.toBe(second.value.utteranceId);
    } else {
      throw new Error("expected two finals");
    }
  });

  it("ignores an identical duplicate completion but rejects a conflicting one", () => {
    const reducer = new TranscriptReducer();
    reducer.apply({ type: "connectionEpoch", epoch: 0, uncertainMs: 0 });
    reducer.apply({ type: "completed", turnRef: "1", text: "done" });
    const duplicate = reducer.apply({ type: "completed", turnRef: "1", text: "done" });
    expect(duplicate.isOk() && duplicate.value === undefined).toBe(true);
    const conflict = reducer.apply({ type: "completed", turnRef: "1", text: "different" });
    expect(conflict.isErr()).toBe(true);
    expect(reducer.finalCount).toBe(1);
  });

  it("rejects partials that cannot be associated and revisions after final", () => {
    const reducer = new TranscriptReducer();
    reducer.apply({ type: "connectionEpoch", epoch: 0, uncertainMs: 0 });
    expect(reducer.apply({ type: "partial", text: "orphan" }).isErr()).toBe(true);
    reducer.apply({ type: "completed", turnRef: "7", text: "closed" });
    const stale = reducer.apply({ type: "partial", turnRef: "7", text: "reopen" });
    expect(stale.isErr()).toBe(true);
  });

  it("attaches speaker labels and resets utterance identity across epochs", () => {
    const reducer = new TranscriptReducer();
    reducer.apply({ type: "connectionEpoch", epoch: 0, uncertainMs: 0 });
    reducer.apply({ type: "turnStarted", turnRef: "1" });
    reducer.apply({ type: "speaker", label: "A" });
    const first = reducer.apply({ type: "completed", turnRef: "1", text: "hello" });
    const epochEvent = reducer.apply({ type: "connectionEpoch", epoch: 1, uncertainMs: 1200 });
    const second = reducer.apply({ type: "completed", turnRef: "1", text: "hello" });
    expect(first.isOk() && first.value?.type === "final" && first.value.speaker).toBe("A");
    expect(epochEvent.isOk() && epochEvent.value?.type === "discontinuity").toBe(true);
    if (
      first.isOk() &&
      second.isOk() &&
      first.value?.type === "final" &&
      second.value?.type === "final"
    ) {
      expect(first.value.utteranceId).not.toBe(second.value.utteranceId);
    } else {
      throw new Error("expected finals in both epochs");
    }
  });
});
