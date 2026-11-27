import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { err, ok } from "neverthrow";

import { appError } from "../dist/kernel/errors.js";
import { TranslationScheduler } from "../dist/modules/language/translation.js";

const scenarios = [
  { interval: 190, response: 100, cooperative: true },
  { interval: 190, response: 600, cooperative: true },
  { interval: 190, response: 600, cooperative: false },
  { interval: 470, response: 600, cooperative: true },
];

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
    const finalText = `${revisions.at(-1)}.`;
    const finalAt = (revisions.length - 1) * interval + 90;
    const calls = [];
    const previews = [];
    let committed;
    let currentRevision;
    const scheduler = new TranslationScheduler({
      now: Date.now,
      signal: new AbortController().signal,
      provider: {
        providerId: "paced-fixture",
        modelId: "fixed-delay",
        async translate({ messages, signal }) {
          const { source } = JSON.parse(messages.find(({ role }) => role === "user").content);
          const call = { startedAt: Date.now(), committed: source === finalText };
          calls.push(call);
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
        if (!isCurrent()) {
          return false;
        }
        if (event.type === "provisional") {
          assert.equal(event.sourceRevision, currentRevision);
          previews.push({ time: Date.now(), revision: event.sourceRevision });
        } else if (event.type === "committed") {
          committed = event;
        }
        return true;
      },
    });

    async function advance(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed += 10) {
        mock.timers.tick(10);
        await setImmediate();
      }
    }

    for (const [revision, text] of revisions.entries()) {
      currentRevision = revision;
      scheduler.consume({ type: "partial", utteranceId: "paced", revision, text });
      await advance(revision === revisions.length - 1 ? 90 : interval);
    }
    currentRevision = revisions.length;
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
    console.log(
      JSON.stringify({
        ...scenario,
        revisions: revisions.length,
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
