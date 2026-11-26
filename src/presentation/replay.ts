import { toAppError, type AppError } from "@kernel/errors";
import { type ReplaySummary, type SessionOutput } from "@modules/session/events";
import { SessionRuntime } from "@modules/session/runtime";
import { openLineSource } from "@platform/fixture";
import { stripFormatting, toStableJson } from "@platform/output";
import { err, type Result } from "neverthrow";

import type { CliOutput } from "./output.js";

export interface ReplayInput {
  readonly fixture: string;
  readonly json: boolean;
  readonly signal: AbortSignal;
  readonly output: CliOutput;
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

export async function runReplaySession(
  input: ReplayInput,
): Promise<Result<ReplaySummary, AppError>> {
  const source = openLineSource(input.fixture);
  const runtime = new SessionRuntime();
  try {
    return await runtime.run(
      source,
      (event) => {
        const line = input.json ? toStableJson(event) : stripFormatting(formatReplayEvent(event));
        input.output.out(line);
      },
      { signal: input.signal },
    );
  } catch (thrown: unknown) {
    return err(toAppError(thrown, "replay failed"));
  }
}
