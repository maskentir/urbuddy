import { renderToString } from "ink";
import { describe, expect, test } from "vitest";

import { buildAuthoredSchedules, buildProviderSchedule, type SliceFixture } from "./adapter.js";
import { RuntimeFeed } from "./feed.js";
import { loadFixture } from "./fixture.js";
import { questionStatus } from "./projection.js";
import { AdaptiveScreen } from "./screen.js";
import { actUser, type Session, type UserState } from "./session.js";

function blankUser(): UserState {
  return {
    view: "live",
    question: undefined,
    revealedHistory: false,
    editing: false,
    text: "",
    noteAtMs: undefined,
    original: false,
    showAnswer: false,
    help: false,
    understoodKey: undefined,
    understoodAtMs: undefined,
    lastViewedKey: undefined,
    contextSel: undefined,
    guidanceDismissed: true,
    scroll: 0,
  };
}

function fixture(): SliceFixture {
  return {
    utterances: [
      {
        id: "t1",
        text: "The cache lock is held by the export worker.",
        speakerKey: "ana",
        startMs: 0,
        durationMs: 4000,
        expectsTranslation: false,
      },
    ],
    questions: [
      {
        id: "q1",
        atMs: 10000,
        text: "Ana, can we restart the worker?",
        meaning: "Amara menanyakan apakah worker boleh dimulai ulang.",
        addressee: "Amara asks Ana.",
        evidence: ["t1"],
      },
    ],
    suggestions: [],
    changes: [],
    recaps: [],
    gaps: [],
    participants: [{ speakerKey: "ana", name: "Ana", role: "SRE" }],
    closing: { review: "Hold.", learn: "What is a cache lock?", answer: "A lock." },
    streamEndMs: 20000,
  };
}

function makeFeed(fix: SliceFixture): RuntimeFeed {
  const authored = buildAuthoredSchedules(fix);
  const feed = new RuntimeFeed({
    sessionId: "test",
    streamId: "main",
    provider: buildProviderSchedule(fix.utterances, (key) => key),
    authoredTranscripts: authored.transcripts,
    translations: authored.translations,
    intelligence: authored.intelligence,
    gapSkips: authored.gapSkips,
  });
  feed.start();
  return feed;
}

async function driveTo(feed: RuntimeFeed, atMs: number): Promise<void> {
  feed.releaseDue(atMs);
  await feed.idle();
}

async function driveIncrementally(feed: RuntimeFeed, untilMs: number): Promise<void> {
  for (let position = 0; position <= untilMs; position += 100) {
    feed.releaseDue(position);
    await feed.idle();
  }
}

function rendered(feed: RuntimeFeed, atMs: number, user: UserState): string {
  const session: Session = { domain: feed.domain, user, atMs, running: false };
  return renderToString(<AdaptiveScreen state={session} size={{ columns: 86, rows: 28 }} />, {
    columns: 86,
  });
}

describe("replayed fixture integrity", () => {
  test("an authored annotation never arrives before its utterance is accepted", async () => {
    const runtime = await loadFixture();
    const feed = new RuntimeFeed({
      sessionId: "test",
      streamId: "main",
      provider: runtime.provider,
      authoredTranscripts: runtime.authoredTranscripts,
      translations: runtime.translations,
      intelligence: runtime.intelligence,
      gapSkips: runtime.gapSkips,
    });
    feed.start();
    await driveIncrementally(feed, 210000);
    feed.finish();
    await feed.completion();
    expect(feed.domain.rejected.filter((item) => item.kind === "annotation")).toEqual([]);
    expect(feed.domain.rejected.filter((item) => item.kind === "translation")).toEqual([]);
  });

  test("every authored translation reaches its utterance", async () => {
    const runtime = await loadFixture();
    const feed = new RuntimeFeed({
      sessionId: "test",
      streamId: "main",
      provider: runtime.provider,
      authoredTranscripts: runtime.authoredTranscripts,
      translations: runtime.translations,
      intelligence: runtime.intelligence,
      gapSkips: runtime.gapSkips,
    });
    feed.start();
    await driveIncrementally(feed, 210000);
    feed.finish();
    await feed.completion();
    const translated = feed.domain.utterances.filter((item) => item.translation !== undefined);
    expect(translated).toHaveLength(4);
    expect(feed.domain.translationsRejected).toBe(0);
  });

  test("both authored coverage notices reach the surface", async () => {
    const runtime = await loadFixture();
    expect(runtime.authoredTranscripts).toHaveLength(2);
    const feed = new RuntimeFeed({
      sessionId: "test",
      streamId: "main",
      provider: runtime.provider,
      authoredTranscripts: runtime.authoredTranscripts,
      translations: runtime.translations,
      intelligence: runtime.intelligence,
      gapSkips: runtime.gapSkips,
    });
    feed.start();
    await driveIncrementally(feed, 210000);
    feed.finish();
    await feed.completion();
    expect(feed.domain.gapDetails).toHaveLength(2);
    const frame = rendered(feed, 175000, blankUser());
    expect(frame).toContain("Celah");
  });

  test("the replay clock does not fabricate domain state", async () => {
    const runtime = await loadFixture();
    const feed = new RuntimeFeed({
      sessionId: "test",
      streamId: "main",
      provider: runtime.provider,
      authoredTranscripts: runtime.authoredTranscripts,
      translations: runtime.translations,
      intelligence: runtime.intelligence,
      gapSkips: runtime.gapSkips,
    });
    feed.start();
    feed.releaseDue(20000);
    await feed.idle();
    const early = feed.domain.utterances.length;
    feed.releaseDue(200000);
    await feed.idle();
    expect(early).toBeLessThan(feed.domain.utterances.length);
    feed.finish();
    await feed.completion();
  });
});

describe("occurrence identity", () => {
  test("overlapping turns keep their own utterance identity", async () => {
    const feed = new RuntimeFeed({
      sessionId: "test",
      streamId: "main",
      provider: [
        { atMs: 0, event: { type: "turnStarted", turnRef: "a" } },
        { atMs: 0, event: { type: "turnStarted", turnRef: "b" } },
        { atMs: 10, event: { type: "partial", turnRef: "b", text: "second" } },
        { atMs: 20, event: { type: "partial", turnRef: "a", text: "first" } },
        { atMs: 30, event: { type: "completed", turnRef: "a", text: "first" } },
        { atMs: 40, event: { type: "completed", turnRef: "b", text: "second" } },
      ],
      authoredTranscripts: [],
      translations: [],
      intelligence: [],
      gapSkips: [],
    });
    feed.start();
    await driveTo(feed, 100);
    const first = feed.registry.resolveTurnRef("a");
    const second = feed.registry.resolveTurnRef("b");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    feed.finish();
    await feed.completion();
  });
});

describe("asynchronous semantics", () => {
  test("a transcript correction supersedes the earlier revision", async () => {
    const feed = new RuntimeFeed({
      sessionId: "test",
      streamId: "main",
      provider: [
        { atMs: 0, event: { type: "turnStarted", turnRef: "t1" } },
        {
          atMs: 100,
          event: { type: "partial", turnRef: "t1", text: "The cursor is at offset nine." },
        },
        {
          atMs: 200,
          event: {
            type: "partial",
            turnRef: "t1",
            text: "The cursor is at offset nine. No, the cursor expired.",
          },
        },
        {
          atMs: 300,
          event: {
            type: "completed",
            turnRef: "t1",
            text: "The cursor is at offset nine. No, the cursor expired.",
          },
        },
      ],
      authoredTranscripts: [],
      translations: [],
      intelligence: [],
      gapSkips: [],
    });
    feed.start();
    await driveTo(feed, 1000);
    const row = feed.domain.utterances[0];
    expect(row?.text).toContain("expired");
    expect(row?.finalized).toBe(true);
    expect(row?.revision).toBeGreaterThan(1);
    feed.finish();
    await feed.completion();
  });

  test("a partial after final fails closed and keeps the final text", async () => {
    const feed = new RuntimeFeed({
      sessionId: "test",
      streamId: "main",
      provider: [
        { atMs: 0, event: { type: "turnStarted", turnRef: "t1" } },
        { atMs: 10, event: { type: "completed", turnRef: "t1", text: "final text" } },
        { atMs: 20, event: { type: "partial", turnRef: "t1", text: "late partial" } },
      ],
      authoredTranscripts: [],
      translations: [],
      intelligence: [],
      gapSkips: [],
    });
    feed.start();
    await driveTo(feed, 1000);
    expect(feed.domain.utterances[0]?.text).toBe("final text");
    expect(feed.domain.rejected.some((item) => item.kind === "provider")).toBe(true);
    feed.finish();
    await feed.completion();
  });

  test("an out-of-order stream event cannot overwrite newer state", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 12000);
    const key = feed.registry.resolveTurnRef("t1");
    const before = key === undefined ? undefined : feed.domain.byKey.get(key)?.text;
    feed.injectStreamEvent({
      sessionId: "test",
      streamId: "main",
      seq: 0,
      kind: "partial",
      utteranceId: key ?? "",
      revision: 0,
      text: "STALE TEXT",
    });
    await feed.idle();
    expect(key === undefined ? undefined : feed.domain.byKey.get(key)?.text).toBe(before);
    expect(feed.domain.stale).toBeGreaterThan(0);
    feed.finish();
    await feed.completion();
  });

  test("a suggestion that arrives without its question is rejected, never activated", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 12000);
    const { applyIntelligence } = await import("./projection.js");
    applyIntelligence(
      feed.domain,
      {
        type: "suggestion-ready",
        atMs: 13000,
        questionId: "unknown-question",
        generation: 0,
        draftEn: "FORGED",
        draftId: "PALSU",
      },
      (turnRef) => feed.registry.resolveTurnRef(turnRef),
    );
    expect(feed.domain.rejected.some((item) => item.kind === "suggestion")).toBe(true);
    expect(feed.domain.questions.has("unknown-question")).toBe(false);
    feed.finish();
    await feed.completion();
  });

  test("a late suggestion for changed evidence never reads as ready", async () => {
    const base = fixture();
    const fix: SliceFixture = {
      ...base,
      changes: [
        { id: "c1", atMs: 14000, affects: ["q1"], invalidates: false, text: "Disk watermark." },
      ],
    };
    const feed = makeFeed(fix);
    await driveTo(feed, 13000);
    const { applyIntelligence } = await import("./projection.js");
    applyIntelligence(
      feed.domain,
      {
        type: "assumption-changed",
        atMs: 14000,
        questionId: "q1",
        text: "Disk watermark.",
        invalidates: false,
      },
      (turnRef) => feed.registry.resolveTurnRef(turnRef),
    );
    applyIntelligence(
      feed.domain,
      {
        type: "suggestion-ready",
        atMs: 15000,
        questionId: "q1",
        generation: 0,
        draftEn: "LATE",
        draftId: "LATE",
      },
      (turnRef) => feed.registry.resolveTurnRef(turnRef),
    );
    const question = feed.domain.questions.get("q1");
    expect(question).toBeDefined();
    expect(questionStatus(question!)).not.toBe("ready");
    feed.finish();
    await feed.completion();
  });

  test("user-authored notes survive provider events", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 12000);
    let session: Session = { domain: feed.domain, user: blankUser(), atMs: 12000, running: false };
    session = actUser(session, "r", 12000);
    session = actUser(session, "x", 12000);
    session = actUser(session, "input:hold", 12000);
    session = actUser(session, "enter", 12000);
    await driveTo(feed, 20000);
    expect(session.user.text).toBe("hold");
    expect(session.user.noteAtMs).toBe(12000);
    feed.finish();
    await feed.completion();
  });
});

describe("runtime instrumentation", () => {
  test("the feed reports quiescence without a bounded busy wait", async () => {
    const feed = makeFeed(fixture());
    feed.releaseDue(20000);
    const started = performance.now();
    await feed.idle();
    expect(performance.now() - started).toBeLessThan(1000);
    feed.finish();
    await feed.completion();
  });

  test("the feed reports latency for every stage it observes", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 20000);
    const summary = feed.latencySummary();
    expect(summary.releaseAcceptMs.count).toBeGreaterThan(0);
    expect(summary.acceptApplyMs.count).toBeGreaterThan(0);
    expect(summary.applyProjectMs.count).toBeGreaterThan(0);
    feed.finish();
    await feed.completion();
  });
});

describe("reference trace", () => {
  test("the committed reference trace matches the runtime event flow", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { buildReferenceTrace, serializeReference } = await import("./reference.js");
    const here = fileURLToPath(new URL(".", import.meta.url));
    const expected = readFileSync(join(here, "trace", "reference.jsonl"), "utf8");
    expect(serializeReference(await buildReferenceTrace())).toBe(expected);
  });
});

describe("invalidated suggestions", () => {
  function invalidatedFixture(): SliceFixture {
    const base = fixture();
    return {
      ...base,
      suggestions: [
        {
          questionId: "q1",
          suggestAtMs: 12000,
          draftEn: "Restart the worker now.",
          draftId: "Mulai ulang worker sekarang.",
          holdingEn: "Let me check the queue.",
          holdingId: "Saya cek antrean dulu.",
        },
      ],
      changes: [
        { id: "c1", atMs: 14000, affects: ["q1"], invalidates: true, text: "The lock was lost." },
      ],
    };
  }

  test("a stale, duplicate, or out-of-order suggestion cannot reactivate an invalidated answer", async () => {
    const feed = makeFeed(invalidatedFixture());
    await driveTo(feed, 13000);
    expect(questionStatus(feed.domain.questions.get("q1")!)).toBe("ready");
    await driveTo(feed, 16000);
    expect(questionStatus(feed.domain.questions.get("q1")!)).toBe("invalidated");

    const { applyIntelligence } = await import("./projection.js");
    const resolve = (turnRef: string): string | undefined => feed.registry.resolveTurnRef(turnRef);
    const ready = (atMs: number, draftEn: string) =>
      applyIntelligence(
        feed.domain,
        {
          type: "suggestion-ready",
          atMs,
          questionId: "q1",
          generation: 0,
          draftEn,
          draftId: draftEn,
        },
        resolve,
      );

    ready(17000, "STALE GENERATION");
    ready(17000, "STALE GENERATION");
    ready(12000, "OUT OF ORDER");

    const question = feed.domain.questions.get("q1")!;
    expect(question.invalidated).toBe(true);
    expect(questionStatus(question)).toBe("invalidated");
    expect(question.suggestion?.draftEn).not.toBe("STALE GENERATION");
    expect(question.suggestion?.draftEn).not.toBe("OUT OF ORDER");
    const frame = rendered(feed, 17000, { ...blankUser(), view: "respond", question: "q1" });
    expect(frame).toContain("SARAN KEDALUWARSA");
    expect(frame).not.toContain("Restart the worker now.");
    feed.finish();
    await feed.completion();
  });

  test("a duplicated assumption change is recorded once", async () => {
    const feed = makeFeed(invalidatedFixture());
    await driveTo(feed, 13000);
    const { applyIntelligence } = await import("./projection.js");
    const resolve = (turnRef: string): string | undefined => feed.registry.resolveTurnRef(turnRef);
    const changed = {
      type: "assumption-changed",
      atMs: 14000,
      questionId: "q1",
      text: "The lock was lost.",
      invalidates: true,
    } as const;
    applyIntelligence(feed.domain, changed, resolve);
    applyIntelligence(feed.domain, changed, resolve);
    const question = feed.domain.questions.get("q1")!;
    expect(question.changes).toEqual(["The lock was lost."]);
    feed.finish();
    await feed.completion();
  });
});
