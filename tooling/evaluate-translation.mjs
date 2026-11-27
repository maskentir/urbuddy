import { once } from "node:events";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { err, ok } from "neverthrow";

import { createTranslationProviderFromEnv } from "../dist/adapters/translation/openai.js";
import { appError } from "../dist/kernel/errors.js";
import { loadTranslationConfig } from "../dist/modules/config/translation.js";
import { TranslationScheduler } from "../dist/modules/language/translation.js";

const { values: options } = parseArgs({
  options: {
    live: { type: "boolean" },
    "allow-egress": { type: "boolean" },
  },
});
if (Boolean(options.live) !== Boolean(options["allow-egress"])) {
  throw new Error("Live evaluation requires both --live and --allow-egress");
}

const corpus = JSON.parse(
  readFileSync(
    new URL("../evaluation/language/corpus/synthetic-001.json", import.meta.url),
    "utf8",
  ),
);
const maximumInvocations = 16;
const plannedInvocations = corpus.cases.reduce((total, item) => total + item.context.length + 1, 0);
if (plannedInvocations > maximumInvocations) {
  throw new Error("Corpus exceeds the evaluation invocation limit");
}

async function emit(value, signal) {
  if (
    !process.stdout.write(`${JSON.stringify(value)}
`)
  ) {
    await once(process.stdout, "drain", { signal });
  }
}

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
let coverageFailed = false;
try {
  const production = options.live
    ? createTranslationProviderFromEnv({
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      })
    : undefined;
  if (production?.isErr()) {
    throw new Error(production.error.message);
  }
  let invocationCount = 0;
  for (const item of corpus.cases) {
    if (controller.signal.aborted) {
      break;
    }
    const config = loadTranslationConfig(true, {
      sourceLanguage: item.sourceLanguage,
      targetLanguage: item.targetLanguage,
    });
    if (config.isErr()) {
      throw new Error(config.error.message);
    }
    const backend = production?.isOk()
      ? production.value
      : {
          providerId: "evaluation-fixture",
          modelId: "echo",
          translate: async (request) => {
            const text = JSON.parse(
              request.messages.find(({ role }) => role === "user").content,
            ).source;
            return ok({ text });
          },
        };
    const caseController = new AbortController();
    const caseSignal = AbortSignal.any([controller.signal, caseController.signal]);
    let stopReason;
    const stopCase = (reason) => {
      stopReason = reason;
      caseController.abort();
    };
    const scheduler = new TranslationScheduler({
      provider: {
        providerId: backend.providerId,
        modelId: backend.modelId,
        translate: async (request) => {
          if (invocationCount >= maximumInvocations) {
            stopCase("invocation budget exhausted");
            return err(appError("CONFIG_INVALID", "evaluation invocation budget exhausted"));
          }
          if (Buffer.byteLength(JSON.stringify(request.messages)) > 4_096) {
            stopCase("input bound exceeded");
            return err(appError("CONFIG_INVALID", "evaluation input bound exceeded"));
          }
          invocationCount += 1;
          try {
            const result = await backend.translate(request);
            if (result.isErr() && result.error.code !== "VALIDATION_FAILED") {
              stopCase(`provider failure (${result.error.code})`);
            }
            return result;
          } catch {
            stopCase("provider invocation rejected");
            return err(appError("INTERNAL", "evaluation provider invocation rejected"));
          }
        },
      },
      signal: caseSignal,
      languages: config.value,
      onEvent: async (event, isCurrent) => {
        if (!isCurrent()) {
          return false;
        }
        await emit({ caseId: item.id, corpusVersion: corpus.version, ...event }, controller.signal);
        return true;
      },
    });
    for (const [index, text] of [...item.context, item.source].entries()) {
      scheduler.consume({
        type: "final",
        utteranceId: index === item.context.length ? item.id : `context-${index}`,
        sourceSequence: index,
        revision: 1,
        text,
      });
    }
    const summary = await scheduler.finish();
    await emit({ type: "translation-complete", caseId: item.id, ...summary }, controller.signal);
    coverageFailed ||= summary.failed;
    if (stopReason !== undefined) {
      console.error(`qualification stopped at ${item.id}: ${stopReason}`);
      break;
    }
    if (summary.unresolvedInvocations || summary.unresolvedPublication) {
      console.error(`qualification stopped at ${item.id}: incomplete cleanup`);
      break;
    }
  }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
if (coverageFailed || controller.signal.aborted) {
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
