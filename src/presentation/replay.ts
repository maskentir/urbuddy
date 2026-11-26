import { appError, toAppError, type AppError } from "@kernel/errors";
import { type ReplaySummary, type SessionOutput } from "@modules/session/events";
import type { EvidencePersistence } from "@modules/session/persistence";
import type { runReplay } from "@modules/session/replay";
import { stripFormatting } from "@platform/output";
import { err, type Result } from "neverthrow";

import type { CliOutput } from "./output.js";

interface ReplayInput {
  readonly fixture: string;
  readonly json: boolean;
  readonly signal: AbortSignal;
  readonly output: CliOutput;
  readonly persist?: boolean;
  readonly operationId?: string;
}

export type ReplayPort = (input: ReplayInput) => Promise<Result<ReplaySummary, AppError>>;

export interface ReplayDeps {
  readonly runOperation: typeof runReplay;
  readonly openFingerprintedSource?: (
    fixture: string,
    signal: AbortSignal,
  ) => Promise<
    Result<
      {
        fingerprint: string;
        source: { readonly events: AsyncIterable<unknown>; dispose(): Promise<void> };
      },
      AppError
    >
  >;
  readonly openSource: (
    fixture: string,
    signal: AbortSignal,
  ) => Promise<
    Result<{ readonly events: AsyncIterable<unknown>; dispose(): Promise<void> }, AppError>
  >;
  readonly openPersistence?: () => Promise<Result<EvidencePersistence, AppError>>;
  readonly newOperationId?: () => string;
}

function formatReplayEvent(event: SessionOutput): string {
  switch (event.type) {
    case "applied":
      return `[seq=${event.seq}] ${event.utteranceId}#r${event.revision} ${event.kind.toUpperCase()}: ${event.text}`;
    case "duplicate":
      return `[seq=${event.seq}] ${event.utteranceId}#r${event.revision} DUPLICATE: ignored`;
    case "stale":
      return `[seq=${event.seq}] ${event.utteranceId}#r${event.revision} STALE (${event.reason}): ignored`;
    case "gap":
      return `[gap] missing seq ${event.from}..${event.to - 1}`;
    case "completed": {
      const s = event.summary;
      return `replay complete: applied=${s.applied} duplicates=${s.duplicates} stale=${s.stale} gaps=${s.gaps} missing=${s.missing}`;
    }
  }
}

export function createReplayPort(deps: ReplayDeps): ReplayPort {
  return async (input) => {
    const emit = async (event: SessionOutput): Promise<void> => {
      const line = input.json ? JSON.stringify(event) : stripFormatting(formatReplayEvent(event));
      await input.output.out(line);
    };
    try {
      if (input.persist !== true) {
        const openedPlain = await deps.openSource(input.fixture, input.signal);
        if (openedPlain.isErr()) {
          return err(openedPlain.error);
        }
        return await deps.runOperation({
          source: openedPlain.value,
          sink: emit,
          signal: input.signal,
        });
      }
      if (deps.openPersistence === undefined || deps.openFingerprintedSource === undefined) {
        return err(
          appError("VALIDATION_FAILED", "persistence requires native module authorization"),
        );
      }
      const operationId = input.operationId ?? deps.newOperationId?.() ?? "";
      if (operationId === "") {
        return err(appError("VALIDATION_FAILED", "persistent replay requires an operation id"));
      }
      if (input.operationId === undefined) {
        await input.output.out(
          input.json
            ? JSON.stringify({ type: "operation", opId: operationId })
            : `operation: ${operationId}`,
        );
      }
      const opened = await deps.openFingerprintedSource(input.fixture, input.signal);
      if (opened.isErr()) {
        return err(opened.error);
      }
      const fingerprint = { value: opened.value.fingerprint };
      const storeResult = await deps.openPersistence();
      if (storeResult.isErr()) {
        await opened.value.source.dispose().catch(() => undefined);
        return err(storeResult.error);
      }
      return await deps.runOperation({
        source: opened.value.source,
        sink: emit,
        signal: input.signal,
        persistence: storeResult.value,
        operationId,
        sourceFingerprint: fingerprint.value,
      });
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "replay failed"));
    }
  };
}
