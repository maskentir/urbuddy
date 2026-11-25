import { toAppError, type AppError } from "@kernel/errors";
import { Box, Text, render } from "ink";
import { err, ok, type Result } from "neverthrow";
import type { JSX } from "react";

export function startupMessageText(version: string, sessionId: string): string {
  return `urbuddy ${version} ready (session ${sessionId})`;
}

function StartupMessage(properties: {
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
}

export async function runInkSmoke(options: InkSmokeOptions): Promise<Result<void, AppError>> {
  if (options.dryRun === true) {
    return ok(undefined);
  }
  try {
    const app = render(<StartupMessage version={options.version} sessionId={options.sessionId} />);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, options.dwellMs ?? 50);
    });
    app.unmount();
    return ok(undefined);
  } catch (thrown: unknown) {
    return err(toAppError(thrown, "ink smoke render failed"));
  }
}
