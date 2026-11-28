import { renderToString } from "ink";
import { describe, expect, test } from "vitest";

import { buildAuthoredSchedules, buildProviderSchedule, type SliceFixture } from "./adapter.js";
import { RuntimeFeed } from "./feed.js";
import { questionStatus, type ProjectedQuestion } from "./projection.js";
import { AdaptiveScreen } from "./screen.js";
import { actUser, type Session, type UserState } from "./session.js";

function utterances() {
  return [
    {
      id: "t1",
      text: "The cache lock is held by the export worker.",
      speakerKey: "ana",
      startMs: 0,
      durationMs: 4000,
      vocab: "cache lock = kunci cache",
      intent: "Ana states who holds the lock.",
      expectsTranslation: true,
      translationAtMs: 9000,
      translationText: "Kunci cache dipegang oleh worker ekspor.",
    },
    {
      id: "t2",
      text: "The queue is draining slowly today and nothing else helps at all.",
      speakerKey: "ben",
      startMs: 5000,
      durationMs: 3000,
      expectsTranslation: false,
    },
  ];
}

function fixture(): SliceFixture {
  return {
    utterances: utterances(),
    questions: [
      {
        id: "q1",
        atMs: 10000,
        text: "Ana or Ben, can we restart the worker?",
        meaning: "Amara menanyakan apakah worker boleh dimulai ulang.",
        addressee: "Belum jelas: Ana atau Ben.",
        evidence: ["t1", "t2"],
      },
    ],
    suggestions: [
      {
        questionId: "q1",
        suggestAtMs: 12000,
        draftEn: "Hold the restart until the queue drains.",
        draftId: "Tahan restart sampai antrean kosong.",
        holdingEn: "Let me check the queue first.",
        holdingId: "Saya cek antrean dulu.",
      },
    ],
    changes: [
      { id: "c1", atMs: 15000, affects: ["q1"], invalidates: true, text: "The lock was lost." },
    ],
    recaps: [
      {
        atMs: 9000,
        fromMs: 0,
        throughMs: 9000,
        text: "Ana holds the lock; the queue drains slowly.",
        evidence: ["t1", "t2"],
      },
    ],
    gaps: [],
    participants: [
      { speakerKey: "ana", name: "Ana", role: "SRE" },
      { speakerKey: "ben", name: "Ben", role: "backend" },
    ],
    closing: { review: "Hold the restart.", learn: "What is a cache lock?", answer: "A lock." },
    streamEndMs: 20000,
  };
}

function makeFeed(fix: SliceFixture, signal?: AbortSignal): RuntimeFeed {
  const authored = buildAuthoredSchedules(fix);
  const feed = new RuntimeFeed({
    sessionId: "test",
    streamId: "main",
    provider: buildProviderSchedule(fix.utterances, (key) => key),
    authoredTranscripts: authored.transcripts,
    translations: authored.translations,
    intelligence: authored.intelligence,
    gapSkips: authored.gapSkips,
    ...(signal === undefined ? {} : { signal }),
  });
  feed.start();
  return feed;
}

async function driveTo(feed: RuntimeFeed, atMs: number): Promise<void> {
  feed.releaseDue(atMs);
  await feed.idle();
}

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

function mustQuestion(feed: RuntimeFeed, id: string): ProjectedQuestion {
  const question = feed.domain.questions.get(id);
  if (question === undefined) throw new Error(`missing question ${id}`);
  return question;
}

function rendered(feed: RuntimeFeed, atMs: number, user: UserState): string {
  const session: Session = { domain: feed.domain, user, atMs, running: false };
  return renderToString(<AdaptiveScreen state={session} size={{ columns: 86, rows: 28 }} />, {
    columns: 86,
  });
}

describe("counterfactual A: missing transcript event", () => {
  test("a removed final never finalizes, even after full playback", async () => {
    const fix = fixture();
    const authored = buildAuthoredSchedules(fix);
    const provider = buildProviderSchedule(fix.utterances, (key) => key).filter(
      (item) => !(item.event.type === "completed" && item.event.turnRef === "t2"),
    );
    const feed = new RuntimeFeed({
      sessionId: "test",
      streamId: "main",
      provider,
      authoredTranscripts: authored.transcripts,
      translations: authored.translations,
      intelligence: authored.intelligence,
      gapSkips: authored.gapSkips,
    });
    feed.start();
    feed.releaseDue(20000);
    await feed.idle();
    feed.finish();
    await feed.completion();
    const key = feed.registry.resolveTurnRef("t2");
    expect(key).toBeDefined();
    const row = key === undefined ? undefined : feed.domain.byKey.get(key);
    expect(row?.finalized).toBe(false);
    const done = feed.domain.utterances.find((item) => item.turnRef === "t1");
    expect(done?.finalized).toBe(true);
    const frame = rendered(feed, 20000, blankUser());
    expect(frame).toContain("Parsial — belum final");
  });
});

describe("counterfactual B: delayed events", () => {
  test("translation stays pending until its event arrives", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 6000);
    const mid = feed.domain.utterances.find((item) => item.turnRef === "t1");
    expect(mid?.finalized).toBe(true);
    expect(mid?.translation).toBeUndefined();
    const pending = rendered(feed, 6000, blankUser());
    expect(pending).not.toContain("Kunci cache");
    await driveTo(feed, 9500);
    const late = feed.domain.utterances.find((item) => item.turnRef === "t1");
    expect(late?.translation?.text).toBe("Kunci cache dipegang oleh worker ekspor.");
    const done = rendered(feed, 9500, blankUser());
    expect(done).toContain("Kunci cache");
    feed.finish();
    await feed.completion();
  });
});

describe("counterfactual C: changed payload", () => {
  test("the UI displays the changed accepted text, not fixture text", async () => {
    const base = fixture();
    const fix: SliceFixture = {
      ...base,
      utterances: base.utterances.map((item) =>
        item.id === "t2" ? { ...item, text: "The queue is draining quickly today instead." } : item,
      ),
    };
    const feed = makeFeed(fix);
    await driveTo(feed, 20000);
    const frame = rendered(feed, 20000, blankUser());
    expect(frame).toContain("draining quickly today instead");
    expect(frame).not.toContain("draining slowly today");
    feed.finish();
    await feed.completion();
  });
});

describe("counterfactual D: revised evidence invalidates the suggestion", () => {
  test("correction after ready quarantines the suggestion and flags the note", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 11500);
    let session: Session = { domain: feed.domain, user: blankUser(), atMs: 11500, running: false };
    session = actUser(session, "r", 11500);
    session = { ...session, user: { ...session.user, text: "Hold for now", noteAtMs: 11500 } };
    await driveTo(feed, 16000);
    const question = mustQuestion(feed, "q1");
    expect(question.invalidated).toBe(true);
    expect(questionStatus(question)).toBe("invalidated");
    const frame = rendered(feed, 16000, session.user);
    expect(frame).toContain("KEDALUWARSA");
    expect(frame).not.toContain("Hold the restart until the queue drains.");
    expect(frame).toContain("DITULIS SEBELUM PERUBAHAN");
    feed.finish();
    await feed.completion();
  });
});

describe("counterfactual E: late stale results are rejected", () => {
  test("older translation revision never overwrites newer displayed text", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 20000);
    const before = feed.domain.utterances.find((item) => item.turnRef === "t1")?.translation?.text;
    expect(before).toBe("Kunci cache dipegang oleh worker ekspor.");
    const key = feed.registry.resolveTurnRef("t1");
    expect(key).toBeDefined();
    const { applyTranslation } = await import("./projection.js");
    applyTranslation(feed.domain, {
      type: "committed",
      operationId: "forged",
      unitId: "forged",
      sourceUtteranceId: key ?? "",
      sourceRevision: 0,
      sourceLanguage: "auto",
      targetLanguage: "id",
      providerId: "forged",
      modelId: "forged",
      promptVersion: "n/a",
      context: [],
      coverageUncertain: false,
      text: "STALE",
      fragment: false,
      sourceArrivedMs: 0,
      queueMs: 0,
      responseMs: 0,
      publicationMs: 0,
    });
    expect(feed.domain.translationsRejected).toBeGreaterThan(0);
    expect(feed.domain.utterances.find((item) => item.turnRef === "t1")?.translation?.text).toBe(
      before,
    );
    feed.finish();
    await feed.completion();
  });

  test("older suggestion generation cannot reactivate an invalidated answer", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 16000);
    const { applyIntelligence } = await import("./projection.js");
    applyIntelligence(
      feed.domain,
      {
        type: "suggestion-ready",
        atMs: 17000,
        questionId: "q1",
        generation: 0,
        draftEn: "FORGED",
        draftId: "PALSU",
      },
      (turnRef) => feed.registry.resolveTurnRef(turnRef),
    );
    const question = mustQuestion(feed, "q1");
    expect(question.invalidated).toBe(true);
    expect(questionStatus(question)).toBe("invalidated");
    expect(feed.domain.rejected.some((item) => item.reason.includes("stale generation"))).toBe(
      true,
    );
    feed.finish();
    await feed.completion();
  });
});

describe("counterfactual F: citation identity across recap change", () => {
  test("selection survives while cited; removal is explicit, never a silent swap", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 9000);
    const first = feed.registry.resolveTurnRef("t1");
    const user: UserState = { ...blankUser(), view: "context", contextSel: first };
    const kept = rendered(feed, 9000, user);
    expect(kept).toContain("Bukti 1/2");
    expect(kept).not.toContain("tidak lagi dikutip");
    const { applyIntelligence } = await import("./projection.js");
    applyIntelligence(
      feed.domain,
      {
        type: "recap-available",
        atMs: 9500,
        fromMs: 5000,
        throughMs: 9000,
        text: "Only the queue matters now.",
        evidence: ["t2"],
      },
      (turnRef) => feed.registry.resolveTurnRef(turnRef),
    );
    const dropped = rendered(feed, 9500, user);
    expect(dropped).toContain("tidak lagi dikutip");
    expect(dropped).toContain("Kunci cache dipegang oleh worker ekspor");
    feed.finish();
    await feed.completion();
  });
});

describe("counterfactual G: duplicate domain events are idempotent", () => {
  test("duplicate question and transcript events do not duplicate state", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 12000);
    const questionCount = feed.domain.questionOrder.length;
    const { applyIntelligence } = await import("./projection.js");
    applyIntelligence(
      feed.domain,
      {
        type: "question-asked",
        atMs: 12000,
        questionId: "q1",
        text: "DUPLICATE",
        meaning: "DUPLIKAT",
        addressee: "X",
        evidence: [],
      },
      (turnRef) => feed.registry.resolveTurnRef(turnRef),
    );
    expect(feed.domain.questionOrder.length).toBe(questionCount);
    expect(mustQuestion(feed, "q1").text).not.toBe("DUPLICATE");
    expect(feed.domain.duplicates).toBeGreaterThan(0);
    const before = feed.domain.utterances.length;
    feed.releaseDue(12000);
    await feed.idle();
    expect(feed.domain.utterances.length).toBe(before);
    feed.finish();
    await feed.completion();
  });
});

describe("counterfactual H: unknown scenario runs unchanged", () => {
  test("different speakers, text, ids and timings work with zero code changes", async () => {
    const { buildAuthoredSchedules, buildProviderSchedule } = await import("./adapter.js");
    const fix: SliceFixture = {
      utterances: [
        {
          id: "z1",
          text: "The nightly backup window moved to midnight.",
          speakerKey: "zoe",
          startMs: 1000,
          durationMs: 2500,
          expectsTranslation: true,
          translationAtMs: 3500,
          translationText: "Jendela backup malam pindah ke tengah malam.",
        },
        {
          id: "z2",
          text: "Did the restore drill pass?",
          speakerKey: "max",
          startMs: 5000,
          durationMs: 2000,
          expectsTranslation: false,
        },
      ],
      questions: [
        {
          id: "zq",
          atMs: 8000,
          text: "Zoe, is the window confirmed?",
          meaning: "Max menanyakan konfirmasi jendela ke Zoe.",
          addressee: "Max asks Zoe.",
          evidence: ["z1"],
        },
      ],
      suggestions: [],
      changes: [],
      recaps: [
        {
          atMs: 7000,
          fromMs: 1000,
          throughMs: 7000,
          text: "Backup moved; drill asked.",
          evidence: ["z1", "z2"],
        },
      ],
      gaps: [],
      participants: [
        { speakerKey: "zoe", name: "Zoe", role: "SRE" },
        { speakerKey: "max", name: "Max", role: "backend" },
      ],
      closing: {
        review: "Window moved.",
        learn: "What is a backup window?",
        answer: "A nightly slot.",
      },
      streamEndMs: 12000,
    };
    const authored = buildAuthoredSchedules(fix);
    const feed = new RuntimeFeed({
      sessionId: "unknown",
      streamId: "main",
      provider: buildProviderSchedule(fix.utterances, (key) => key),
      authoredTranscripts: authored.transcripts,
      translations: authored.translations,
      intelligence: authored.intelligence,
      gapSkips: authored.gapSkips,
    });
    feed.start();
    feed.releaseDue(12000);
    await feed.idle();
    feed.finish();
    await feed.completion();
    expect(feed.fatal).toBeUndefined();
    const frame = renderToString(
      <AdaptiveScreen
        state={{ domain: feed.domain, user: blankUser(), atMs: 12000, running: false }}
        size={{ columns: 86, rows: 28 }}
      />,
      { columns: 86 },
    );
    expect(frame).toContain("Did the restore drill pass");
    expect(frame).toContain("Jendela backup malam");
    expect(frame).toContain("Zoe");
    const drawerUser = { ...blankUser(), view: "respond" as const, question: "zq" };
    const drawer = rendered(feed, 12000, drawerUser);
    expect(drawer).toContain("Belum ada saran berbasis bukti");
  });
});

describe("deterministic replay", () => {
  test("same schedule twice yields identical projected domain state", async () => {
    const snapshotOf = async (): Promise<string> => {
      const feed = makeFeed(fixture());
      await driveTo(feed, 20000);
      feed.finish();
      await feed.completion();
      return JSON.stringify({
        utterances: feed.domain.utterances,
        questions: [...feed.domain.questions.values()],
        gaps: feed.domain.gaps,
        gapDetails: feed.domain.gapDetails,
        duplicates: feed.domain.duplicates,
        stale: feed.domain.stale,
        translationsRejected: feed.domain.translationsRejected,
        closed: feed.domain.closed,
      });
    };
    expect(await snapshotOf()).toBe(await snapshotOf());
  });
});

describe("cancellation and shutdown", () => {
  test("abort stops the runtime and freezes projected state", async () => {
    const controller = new AbortController();
    const feed = makeFeed(fixture(), controller.signal);
    await driveTo(feed, 6000);
    const before = JSON.stringify(feed.domain.utterances);
    controller.abort();
    feed.abort();
    await feed.completion();
    expect(feed.fatal?.code).toBe("CANCELLED");
    feed.releaseDue(20000);
    await feed.idle();
    expect(JSON.stringify(feed.domain.utterances)).toBe(before);
  });

  test("finish resolves completion and marks stream ended", async () => {
    const feed = makeFeed(fixture());
    await driveTo(feed, 20000);
    feed.finish();
    await feed.completion();
    expect(feed.fatal).toBeUndefined();
    expect(feed.domain.streamEnded).toBe(true);
  });
});
