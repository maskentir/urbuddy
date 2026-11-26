import { setTimeout as delay } from "node:timers/promises";

import { appError, toAppError, type AppError } from "@kernel/errors";
import { Box, Text, render } from "ink";
import { err, ok, type Result } from "neverthrow";
import type { JSX } from "react";

export function startupMessageText(version: string, sessionId: string): string {
  return `urbuddy ${version} ready (session ${sessionId})`;
}

export function StartupMessage(properties: {
  readonly version: string;
  readonly sessionId: string;
}): JSX.Element {
  return (
    <Box>
      <Text color="green">{startupMessageText(properties.version, properties.sessionId)}</Text>
    </Box>
  );
}

export interface InkSmokeOptions {
  readonly version: string;
  readonly sessionId: string;
  readonly dwellMs?: number;
  readonly signal?: AbortSignal;
}

export async function runInkSmoke(options: InkSmokeOptions): Promise<Result<void, AppError>> {
  if (options.signal !== undefined && options.signal.aborted) {
    return err(appError("CANCELLED", "ink smoke cancelled"));
  }
  try {
    const app = render(<StartupMessage version={options.version} sessionId={options.sessionId} />);
    try {
      await delay(options.dwellMs ?? 50, undefined, { signal: options.signal });
      return ok(undefined);
    } catch (thrown: unknown) {
      if (options.signal !== undefined && options.signal.aborted) {
        return err(appError("CANCELLED", "ink smoke cancelled"));
      }
      return err(toAppError(thrown, "ink smoke dwell failed"));
    } finally {
      app.unmount();
    }
  } catch (thrown: unknown) {
    return err(toAppError(thrown, "ink smoke render failed"));
  }
}
