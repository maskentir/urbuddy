import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { err, ok } from "neverthrow";

import { appError } from "../dist/kernel/errors.js";
import { TranslationScheduler } from "../dist/modules/language/translation.js";

const baseline = [
  { interval: 190, response: 100, cooperative: true },
  { interval: 190, response: 600, cooperative: true },
  { interval: 190, response: 600, cooperative: false },
  { interval: 470, response: 600, cooperative: true },
];

const experiment = process.argv.includes("--snapshot");
const scenarios = experiment
  ? [
      ...baseline,
      ...[1375, 2920].flatMap((response) => [
        { interval: 190, response: Math.ceil(response / 10) * 10, cooperative: true },
        {
          interval: 190,
          response: Math.ceil(response / 10) * 10,
          cooperative: true,
          sustained: true,
        },
      ]),
    ].flatMap((scenario) => [scenario, { ...scenario, snapshot: true }])
  : baseline;
const SNAPSHOT_INTERVAL_MS = 1_500;
const SNAPSHOT_MAX_AGE_MS = 3_300;
const MAX_SNAPSHOTS = 4;

for (const scenario of scenarios) {
  test(JSON.stringify(scenario), async ({ mock }) => {
    const { interval, response, cooperative } = scenario;
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const revisions = [
      "We can deploy",
      "We can deploy today",
      "We can deploy Monday",
      "We can't deploy Monday",
    ];
    for (const word of "until the migration is checked and Mira confirms that the staging queue has drained before we proceed".split(
      " ",
    )) {
      revisions.push(`${revisions.at(-1)} ${word}`);
    }
    if (scenario.sustained) {
      for (const word of "and the release team checks the service dashboard and confirms the customer traffic is steady during the maintenance window".split(
        " ",
      )) {
        revisions.push(`${revisions.at(-1)} ${word}`);
      }
      const firstCapture = Math.ceil(600 / interval) * interval;
      const correction = Math.ceil((firstCapture + response + 25) / interval);
      for (let revision = correction; revision < revisions.length; revision += 1) {
        revisions[revision] = revisions[revision].replace(
          "can't deploy Monday",
          "can deploy Tuesday",
        );
      }
    }
    const finalText = `${revisions.at(-1)}.`;
    const finalAt = (revisions.length - 1) * interval + 90;
    const calls = [];
    const previews = [];
    let committed;
    let currentRevision;
    let currentText;
    let snapshot;
    let visible;
    let sampled = 0;
    let lastCaptureAt = -900;
    let publishing = 0;
    let peakPublications = 0;
    let peakInvocations = 0;
    const invalidations = [];
    const materialCorrections = [];
    const sameOrWordAppend = (text, prefix) => text === prefix || text.startsWith(`${prefix} `);
    const hide = (reason) => {
      if (visible !== undefined) {
        invalidations.push({ revision: visible.revision, time: Date.now(), reason });
        visible = undefined;
      }
    };
    const scheduler = new TranslationScheduler({
      now: Date.now,
      ...(scenario.snapshot ? { debounceMs: 0 } : {}),
      signal: new AbortController().signal,
      provider: {
        providerId: "paced-fixture",
        modelId: "fixed-delay",
        async translate({ messages, signal }) {
          const { source } = JSON.parse(messages.find(({ role }) => role === "user").content);
          const call = { startedAt: Date.now(), committed: source === finalText };
          calls.push(call);
          peakInvocations = Math.max(
            peakInvocations,
            calls.filter(({ settledAt }) => settledAt === undefined).length,
          );
          return new Promise((resolve) => {
            const finish = (cancelled) => {
              signal.removeEventListener("abort", abort);
              call.settledAt = Date.now();
              call.cancelled = cancelled;
              resolve(
                cancelled ? err(appError("CANCELLED", "fixture cancelled")) : ok({ text: source }),
              );
            };
            const timer = setTimeout(() => finish(false), response);
            const abort = () => {
              call.aborted = true;
              if (cooperative) {
                clearTimeout(timer);
                finish(true);
              }
            };
            signal.addEventListener("abort", abort, { once: true });
          });
        },
      },
      onEvent: async (event, isCurrent) => {
        publishing += 1;
        peakPublications = Math.max(peakPublications, publishing);
        try {
          if (scenario.snapshot) {
            await setImmediate();
          }
          if (!isCurrent()) {
            return false;
          }
          if (event.type === "provisional") {
            if (scenario.snapshot) {
              if (
                snapshot?.revision !== event.sourceRevision ||
                !sameOrWordAppend(currentText, snapshot.text) ||
                Date.now() - snapshot.at > SNAPSHOT_MAX_AGE_MS
              ) {
                return false;
              }
              visible = {
                kind: "snapshot",
                revision: event.sourceRevision,
                time: Date.now(),
                capturedAt: snapshot.at,
                ageMs: Date.now() - snapshot.at,
                currentRevision,
              };
              previews.push(visible);
            } else {
              assert.equal(event.sourceRevision, currentRevision);
              previews.push({ time: Date.now(), revision: event.sourceRevision });
            }
          } else if (event.type === "invalidated" && visible?.revision === event.sourceRevision) {
            hide("superseded snapshot");
          } else if (event.type === "committed") {
            committed = event;
          }
          return true;
        } finally {
          publishing -= 1;
        }
      },
    });

    async function advance(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed += 10) {
        mock.timers.tick(10);
        await setImmediate();
        if (visible !== undefined && Date.now() - visible.capturedAt > SNAPSHOT_MAX_AGE_MS) {
          hide("age bound");
        }
      }
    }

    for (const [revision, text] of revisions.entries()) {
      currentRevision = revision;
      currentText = text;
      if (!scenario.snapshot) {
        scheduler.consume({ type: "partial", utteranceId: "paced", revision, text });
      } else if (snapshot !== undefined && !sameOrWordAppend(text, snapshot.text)) {
        materialCorrections.push({
          revision,
          invalidatedRevision: snapshot.revision,
          time: Date.now(),
          wasVisible: visible?.revision === snapshot.revision,
        });
        hide("material correction");
        snapshot = undefined;
        scheduler.consume({ type: "partial", utteranceId: "paced", revision, text: "" });
      } else if (
        sampled < MAX_SNAPSHOTS &&
        Date.now() - lastCaptureAt >= SNAPSHOT_INTERVAL_MS &&
        !calls.some(({ settledAt }) => settledAt === undefined)
      ) {
        sampled += 1;
        lastCaptureAt = Date.now();
        snapshot = { revision, text, at: lastCaptureAt };
        scheduler.consume({ type: "partial", utteranceId: "paced", revision, text });
      }
      await advance(revision === revisions.length - 1 ? 90 : interval);
    }
    currentRevision = revisions.length;
    currentText = finalText;
    hide("final");
    snapshot = undefined;
    scheduler.consume({
      type: "final",
      utteranceId: "paced",
      revision: revisions.length,
      text: finalText,
    });
    const finish = scheduler.finish();
    await advance(response * 2);
    const summary = await finish;
    assert.equal(committed?.text, finalText);
    assert.equal(summary.finalized, 1);
    assert.equal(summary.committed, 1);
    assert.equal(summary.unresolvedInvocations, 0);
    assert.equal(summary.unresolvedPublication, false);
    assert.equal(
      calls.every(({ settledAt }) => settledAt !== undefined),
      true,
    );
    assert.equal(summary.publicationFailures, 0);
    const partialCalls = calls.filter((call) => !call.committed);
    assert.equal(peakInvocations, 1);
    assert.equal(peakPublications, 1);
    assert.equal(publishing, 0);
    assert.equal(visible, undefined);
    assert.equal(calls.filter((call) => call.committed).length, 1);
    assert.equal(
      partialCalls.every(({ startedAt }) => startedAt < finalAt),
      true,
    );
    if (scenario.snapshot) {
      assert.ok(partialCalls.length <= MAX_SNAPSHOTS);
      assert.ok(
        previews.every(
          (preview) => preview.kind === "snapshot" && preview.ageMs <= SNAPSHOT_MAX_AGE_MS,
        ),
      );
      for (const correction of materialCorrections) {
        assert.ok(
          !previews.some(
            (preview) =>
              preview.revision === correction.invalidatedRevision &&
              preview.time >= correction.time,
          ),
        );
        if (correction.wasVisible) {
          assert.ok(
            invalidations.some(
              (event) =>
                event.revision === correction.invalidatedRevision &&
                event.time === correction.time &&
                event.reason === "material correction",
            ),
          );
        }
      }
      if (scenario.sustained) {
        assert.ok(
          previews.some(
            ({ time, revision, currentRevision }) => time < finalAt && revision < currentRevision,
          ),
        );
        assert.ok(invalidations.some(({ reason }) => reason === "material correction"));
      }
    }
    console.log(
      JSON.stringify({
        ...scenario,
        revisions: revisions.length,
        ...(experiment
          ? {
              policy: scenario.snapshot ? "bounded-snapshot" : "current",
              previews,
              invalidations,
              materialCorrections,
              peakInvocations,
              peakPublications,
            }
          : {}),
        provisionalStarted: partialCalls.length,
        abortSignals: partialCalls.filter((call) => call.aborted).length,
        cancelledInvocations: summary.cancelledInvocations,
        staleRejected: summary.staleRejected,
        staleResponses: partialCalls.filter((call) => call.aborted && !call.cancelled).length,
        usefulPreviews: previews.filter(({ time }) => time < finalAt).length,
        previewRevisions: previews.map(({ revision }) => revision),
        firstUsefulPreviewMs: previews.find(({ time }) => time < finalAt)?.time ?? null,
        committedAdmissionMs: committed?.queueMs ?? null,
        committedResponseMs: committed?.responseMs ?? null,
        committedCompletionMs: committed?.publicationMs ?? null,
        finalized: summary.finalized,
        committed: summary.committed,
        allCallsSettled: calls.every(({ settledAt }) => settledAt !== undefined),
        drainMs: summary.drainMs,
        unresolvedInvocations: summary.unresolvedInvocations,
        unresolvedPublication: summary.unresolvedPublication,
      }),
    );
  });
}
