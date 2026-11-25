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
  readonly dryRun?: boolean;
  readonly dwellMs?: number;
  readonly signal?: AbortSignal;
}

function settleFrame(dwellMs: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      done();
    }, dwellMs);
    function done(): void {
      clearTimeout(timer);
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve(true);
    }
    function onAbort(): void {
      clearTimeout(timer);
      resolve(false);
    }
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runInkSmoke(options: InkSmokeOptions): Promise<Result<void, AppError>> {
  if (options.dryRun === true) {
    return ok(undefined);
  }
  if (options.signal !== undefined && options.signal.aborted) {
    return err(appError("CANCELLED", "ink smoke cancelled"));
  }
  try {
    const app = render(<StartupMessage version={options.version} sessionId={options.sessionId} />);
    try {
      const finished = await settleFrame(options.dwellMs ?? 50, options.signal);
      return finished ? ok(undefined) : err(appError("CANCELLED", "ink smoke cancelled"));
    } finally {
      app.unmount();
    }
  } catch (thrown: unknown) {
    return err(toAppError(thrown, "ink smoke render failed"));
  }
}
