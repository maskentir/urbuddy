import { toAppError, type AppError } from "@kernel/errors";
import { type ReplaySummary, type SessionOutput } from "@modules/session/events";
import { stripFormatting } from "@platform/output";
import { err, type Result } from "neverthrow";

import type { CliOutput } from "./output.js";

interface ReplayInput {
  readonly fixture: string;
  readonly json: boolean;
  readonly signal: AbortSignal;
  readonly output: CliOutput;
}

export type ReplayPort = (input: ReplayInput) => Promise<Result<ReplaySummary, AppError>>;

interface ReplayEngine {
  run(
    source: {
      readonly events: AsyncIterable<unknown>;
      dispose(): Promise<void>;
    },
    sink: (event: SessionOutput) => void | Promise<void>,
    options: { readonly signal: AbortSignal },
  ): Promise<Result<ReplaySummary, AppError>>;
}

export interface ReplayDeps {
  readonly runtime: ReplayEngine;
  readonly openSource: (
    fixture: string,
    signal: AbortSignal,
  ) => Promise<
    Result<{ readonly events: AsyncIterable<unknown>; dispose(): Promise<void> }, AppError>
  >;
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
    const opened = await deps.openSource(input.fixture, input.signal);
    if (opened.isErr()) {
      return err(opened.error);
    }
    try {
      return await deps.runtime.run(
        opened.value,
        async (event) => {
          const line = input.json
            ? JSON.stringify(event)
            : stripFormatting(formatReplayEvent(event));
          await input.output.out(line);
        },
        { signal: input.signal },
      );
    } catch (thrown: unknown) {
      return err(toAppError(thrown, "replay failed"));
    }
  };
}
