import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { runReplay } from "@modules/session/replay";
import { openFingerprintedFixture } from "@platform/fixture";
import { openEvidenceDatabase } from "@platform/persistence/database";
import * as evidence from "@platform/persistence/evidence";
import { createReplayPort } from "@presentation/replay";
import { err, ok } from "neverthrow";

const [, , fixture, dataRoot, operationId, markerPath] = process.argv;
if (
  fixture === undefined ||
  dataRoot === undefined ||
  operationId === undefined ||
  markerPath === undefined
) {
  throw new Error("usage: commit-barrier <fixture> <dataRoot> <operationId> <markerPath>");
}

const port = createReplayPort({
  runOperation: runReplay,
  openSource: async () => {
    throw new Error("persist path must use the fingerprinted source");
  },
  openFingerprintedSource: (path, signal) => openFingerprintedFixture(path, { signal }),
  openPersistence: async () => {
    const opened = openEvidenceDatabase(join(dataRoot, "evidence.sqlite"));
    if (opened.isErr()) {
      return err(opened.error);
    }
    const handle = opened.value;
    return ok({
      admit: async (opId, sourceFingerprint) =>
        evidence.admitOperation(handle, opId, sourceFingerprint),
      record: async (event, opId) => {
        const result = evidence.recordEvent(handle, { ...event, opId });
        return result.isOk() ? ok(undefined) : err(result.error);
      },
      recordGap: async (gap) => evidence.recordGap(handle, gap),
      verify: async (event) => evidence.verifyEvent(handle, event),
      complete: async (completion) => {
        const result = evidence.completeOperation(handle, completion);
        return result.isOk() ? ok(undefined) : err(result.error);
      },
      close: async () => handle.close(),
    });
  },
});

/** [correctness] Referenced interval keeps the event loop alive until the parent SIGKILLs this harness. An unsettled promise alone does not hold the loop, so without this the process exits after the marker write and the controlled kill races a dead process group. Never unref or clear it. */
void setInterval(() => undefined, 1000);

const barrierOutput = {
  out: async (line: string): Promise<void> => {
    if (line.startsWith("replay complete")) {
      writeFileSync(markerPath, "committed", "utf8");
      await new Promise<never>(() => undefined);
    }
    process.stdout.write(`${line}\n`);
  },
  errLine: (line: string): void => {
    process.stderr.write(`${line}\n`);
  },
};

await port({
  fixture,
  json: false,
  signal: new AbortController().signal,
  output: barrierOutput,
  persist: true,
  operationId,
});
