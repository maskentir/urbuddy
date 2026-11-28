# Event-driven runtime integration implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use galyarder-framework:subagent-driven-development (recommended) or galyarder-framework:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the accepted Adaptive Single Flow surface in the audio-backed
vertical slice genuinely driven by canonical runtime events, so the renderer
and the session projection never infer domain state from a scenario clock.

**Architecture:** The lab keeps the production contracts. A replay adapter
turns authored fixtures into provider events; `TranscriptReducer` assigns
occurrence identity and revisions; `SessionRuntime` enforces sequence,
duplicate, and stale rules; a lab projection maps accepted session output
and asynchronous translation/intelligence events into domain state; the
renderer reads only projected state. The replay clock only decides which
events are available, never what the domain state is.

**Tech Stack:** TypeScript (strict), Node 24, Vitest, Ink/React, existing
production modules under `src/modules/{perception,session,language}`.

**Branch:** `feat/event-driven-runtime-integration`, based on the frozen
audio-slice revision `5a937fbe9ebf5ec09349d54c0023c90d81067755`.

**Spec:** `docs/specs/2026-11-28-event-driven-runtime-integration.md`

## File structure

| File                                 | Responsibility                                                       |
| ------------------------------------ | -------------------------------------------------------------------- |
| `lab/audio-slice/adapter.ts`         | Fixture to provider/authored event schedules; turn identity registry |
| `lab/audio-slice/fixture.ts`         | Scenario plus audio manifest to a `SliceFixture`                     |
| `lab/audio-slice/feed.ts`            | Drives `TranscriptReducer` and `SessionRuntime`; instruments them    |
| `lab/audio-slice/projection.ts`      | Accepted events to domain state                                      |
| `lab/audio-slice/session.ts`         | User interaction state only                                          |
| `lab/audio-slice/screen.tsx`         | Renderer over projected state only                                   |
| `lab/audio-slice/run.tsx`            | Offline interactive launcher and trace writer                        |
| `lab/audio-slice/capture.tsx`        | Deterministic frame capture                                          |
| `lab/audio-slice/runtime.test.tsx`   | Counterfactual evidence A-H                                          |
| `lab/audio-slice/semantics.test.tsx` | Asynchronous semantics matrix                                        |

---

### Task 1: One utterance timeline shared by provider and authored schedules

**Files:**

- Modify: `lab/audio-slice/adapter.ts`
- Test: `lab/audio-slice/semantics.test.tsx`

The provider schedule and the authored schedule must agree on when a turn
becomes visible. Today the annotation is scheduled at the utterance start,
before any transcript is accepted, so the projection rejects it.

- [ ] **Step 1: Write the failing test**

```ts
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
  for (let position = 0; position <= 210000; position += 100) {
    feed.releaseDue(position);
    await feed.idle();
  }
  feed.finish();
  await feed.completion();
  expect(feed.domain.rejected.filter((item) => item.kind === "annotation")).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run --config lab/audio-slice/vitest.config.ts`
Expected: FAIL, the annotation rejection list is not empty.

- [ ] **Step 3: Write minimal implementation**

In `lab/audio-slice/adapter.ts`:

```ts
export interface UtteranceTimeline {
  readonly turnRef: string;
  readonly partials: readonly string[];
  readonly firstPartialMs: number;
  readonly finalMs: number;
}

function partialTexts(text: string): readonly string[] {
  const marker = ". No, ";
  const index = text.indexOf(marker);
  if (index < 0) return chunkText(text);
  return [text.slice(0, index + 1), text];
}

export function utteranceTimeline(item: FixtureUtterance): UtteranceTimeline {
  const partials = partialTexts(item.text);
  return {
    turnRef: item.id,
    partials,
    firstPartialMs: item.startMs + Math.round((1 / (partials.length + 1)) * item.durationMs),
    finalMs: item.startMs + item.durationMs,
  };
}
```

`buildProviderSchedule` uses `utteranceTimeline(item)` for its partial
times. `buildAuthoredSchedules` schedules `utterance-annotated` at
`timeline.firstPartialMs` and the translation at
`Math.max(timeline.finalMs, item.translationAtMs ?? timeline.finalMs)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run --config lab/audio-slice/vitest.config.ts`
Expected: PASS.

---

### Task 2: Identity correlation from the source provider event

**Files:**

- Modify: `lab/audio-slice/adapter.ts`, `lab/audio-slice/feed.ts`
- Test: `lab/audio-slice/semantics.test.tsx`

The registry currently pairs a turn reference with an utterance by FIFO
position. That mis-assigns identity when turns overlap. The feed already
knows which provider event produced an accepted transcript event.

- [ ] **Step 1: Write the failing test**

```ts
test("overlapping turns keep their own utterance identity", async () => {
  const provider = [
    { atMs: 0, event: { type: "turnStarted", turnRef: "a" } as const },
    { atMs: 0, event: { type: "turnStarted", turnRef: "b" } as const },
    { atMs: 10, event: { type: "partial", turnRef: "b", text: "second" } as const },
    { atMs: 20, event: { type: "partial", turnRef: "a", text: "first" } as const },
    { atMs: 30, event: { type: "completed", turnRef: "a", text: "first" } as const },
    { atMs: 40, event: { type: "completed", turnRef: "b", text: "second" } as const },
  ];
  const feed = new RuntimeFeed({
    sessionId: "test",
    streamId: "main",
    provider,
    authoredTranscripts: [],
    translations: [],
    intelligence: [],
    gapSkips: [],
  });
  feed.start();
  feed.releaseDue(100);
  await feed.idle();
  expect(feed.registry.resolveTurnRef("a")).toBeDefined();
  expect(feed.registry.resolveTurnRef("b")).toBeDefined();
  expect(feed.registry.resolveTurnRef("a")).not.toBe(feed.registry.resolveTurnRef("b"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run --config lab/audio-slice/vitest.config.ts`
Expected: FAIL, both turn references resolve to the same utterance.

- [ ] **Step 3: Write minimal implementation**

In `lab/audio-slice/adapter.ts`:

```ts
export class TurnRegistry {
  private readonly turnToKey = new Map<string, string>();
  private readonly keyToTurn = new Map<string, string>();

  observeAccepted(event: TranscriptEvent, source: SpeechProviderEvent): void {
    if (event.type !== "partial" && event.type !== "final") return;
    if (this.keyToTurn.has(event.utteranceId)) return;
    const turnRef = sourceTurnRef(source);
    if (turnRef === undefined) return;
    this.turnToKey.set(turnRef, event.utteranceId);
    this.keyToTurn.set(event.utteranceId, turnRef);
  }

  resolveTurnRef(turnRef: string): string | undefined {
    return this.turnToKey.get(turnRef);
  }

  turnRefFor(utteranceId: string): string | undefined {
    return this.keyToTurn.get(utteranceId);
  }
}

function sourceTurnRef(source: SpeechProviderEvent): string | undefined {
  if (source.type === "partial") return source.turnRef;
  if (source.type === "completed") return source.turnRef;
  return undefined;
}
```

In `lab/audio-slice/feed.ts`, `acceptTranscript` receives the source
provider event and calls `this.registry.observeAccepted(event, source)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run --config lab/audio-slice/vitest.config.ts`
Expected: PASS.

---

### Task 3: Every authored translation reaches the surface

**Files:**

- Modify: `lab/audio-slice/adapter.ts`
- Test: `lab/audio-slice/semantics.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
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
  feed.releaseDue(210000);
  await feed.idle();
  feed.finish();
  await feed.completion();
  const translated = feed.domain.utterances.filter((item) => item.translation !== undefined);
  expect(translated).toHaveLength(4);
  expect(feed.domain.translationsRejected).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run --config lab/audio-slice/vitest.config.ts`
Expected: FAIL, only one translation is delivered.

- [ ] **Step 3: Write minimal implementation**

The schedule in Task 1 already schedules every translated utterance. The
remaining half is the fixture: `lab/audio-slice/fixture.ts` must pass the
authored translation time for every utterance that has a translation text.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

---

### Task 4: Both coverage notices are projected

**Files:**

- Modify: `lab/audio-slice/fixture.ts`
- Test: `lab/audio-slice/semantics.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
test("both authored coverage notices are projected", async () => {
  const runtime = await loadFixture();
  expect(runtime.authoredTranscripts).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL, one notice is present.

- [ ] **Step 3: Write minimal implementation**

`lab/audio-slice/fixture.ts` builds the gap list from the scenario coverage
entries instead of one hardcoded gap, and takes the stream end from the
scenario end constant instead of a literal.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

---

### Task 5: A suggestion based on superseded evidence never reads as ready

**Files:**

- Modify: `lab/audio-slice/projection.ts`
- Test: `lab/audio-slice/semantics.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
test("a late suggestion for changed evidence never becomes ready", async () => {
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
      draftEn: "LATE",
      draftId: "LATE",
    },
    (turnRef) => feed.registry.resolveTurnRef(turnRef),
  );
  expect(questionStatus(mustQuestion(feed, "q1"))).not.toBe("ready");
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL, the status is `ready`.

- [ ] **Step 3: Write minimal implementation**

In `applyIntelligence`, the `suggestion-ready` branch sets the status to
`changed` when the question already carries changes, and keeps the
existing generation and invalidation guards.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

---

### Task 6: Quiescence without a busy wait

**Files:**

- Modify: `lab/audio-slice/feed.ts`
- Test: `lab/audio-slice/semantics.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
test("the feed reports quiescence without a bounded busy wait", async () => {
  const feed = makeFeed(fixture());
  feed.releaseDue(20000);
  const started = performance.now();
  await feed.idle();
  expect(performance.now() - started).toBeLessThan(1000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: the current implementation waits on `setImmediate` turns.

- [ ] **Step 3: Write minimal implementation**

`EventQueue` resolves idle waiters when the last in-flight item is
consumed, instead of polling a fixed number of event-loop turns.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

---

### Task 7: Instrumentation covers projection, translation, and render

**Files:**

- Modify: `lab/audio-slice/feed.ts`, `lab/audio-slice/run.tsx`
- Test: `lab/audio-slice/semantics.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
test("the feed reports latency for every stage it observes", async () => {
  const feed = makeFeed(fixture());
  await driveTo(feed, 20000);
  const summary = feed.latencySummary();
  expect(summary.releaseAcceptMs.count).toBeGreaterThan(0);
  expect(summary.acceptApplyMs.count).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL, the projection stage is missing.

- [ ] **Step 3: Write minimal implementation**

`FeedInstrumentation` gains projection-update marks and translation-arrival
marks. `run.tsx` records a render observation with a monotonic timestamp
per rerender and labels the replay clock as the software clock.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

---

### Task 8: Documentation, launch command, and evidence

**Files:**

- Create: `docs/decisions/008-event-driven-runtime-integration.md`
- Create: `docs/qualification/muse-stt-readiness.md`
- Modify: `lab/audio-slice/README.md`, `package.json`

- [ ] **Step 1: Add the launch command**

```json
"lab:audio-slice": "tsx --tsconfig lab/audio-slice/tsconfig.json lab/audio-slice/run.tsx",
"lab:audio-slice:test": "vitest run --config lab/audio-slice/vitest.config.ts",
```

- [ ] **Step 2: Rewrite the lab README**

Document the canonical flow, the replay clock semantics, the command list,
the trace format, the UNVERIFIED physical audio alignment, and the fact
that speech recognition is not used.

- [ ] **Step 3: Record the architecture decision**

`docs/decisions/008-event-driven-runtime-integration.md` records the
canonical path, the ownership table, and the rejected alternatives.

- [ ] **Step 4: Record provider qualification readiness**

`docs/qualification/muse-stt-readiness.md` lists the configuration, the
credential check without disclosure, the explicit provider selection, the
request and duration limits, the cost ceiling, the cancellation and retry
policy, the failure isolation, the data handling, and the observable
success criteria. No paid request is issued.

- [ ] **Step 5: Run the repository gate**

Run: `pnpm check`
Expected: typecheck, lint, test, dependency cruise, knip, and format all
pass.

---

### Task 9: Verification package

- [ ] **Step 1: Run the lab suite**

Run: `pnpm lab:audio-slice:test`
Expected: all counterfactual and semantics tests pass.

- [ ] **Step 2: Run the repository build and smoke**

Run: `pnpm build && pnpm smoke`
Expected: clean build and a passing doctor smoke path.

- [ ] **Step 3: Capture PTY evidence**

Run: `(sleep 8; printf 'q') | script -q /dev/null pnpm lab:audio-slice`
Expected: the terminal surface renders in a PTY and the shutdown trace is
written.

- [ ] **Step 4: Regenerate the deterministic frames and reference trace**

Run: `pnpm lab:audio-slice:capture`
Expected: the committed `.ansi` frames match the runtime output.

---

## Self-review

Spec coverage: sections 2 through 11 of the spec map to tasks 1 through 9.
Placeholder scan: every step carries exact code or exact commands. Type
consistency: `observeAccepted(event, source)`, `utteranceTimeline(item)`,
`FeedInstrumentation`, and `latencySummary()` are used with the same
signature everywhere they appear.
