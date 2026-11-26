import { createReadStream, type ReadStream } from "node:fs";

import { appError, type AppError } from "@kernel/errors";

export interface LineSource {
  readonly events: AsyncIterable<unknown>;
  dispose(): Promise<void>;
}

const DEFAULT_MAX_LINE_BYTES = 1_048_576;

function fixtureFailure(path: string, message: string): AppError {
  return appError("VALIDATION_FAILED", message, { details: { path } });
}

async function* readLines(
  path: string,
  stream: ReadStream,
  maxLineBytes: number,
): AsyncGenerator<unknown, void, void> {
  let pending = "";
  let lineNumber = 0;
  const fail = (message: string): AppError => fixtureFailure(path, message);
  try {
    for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      pending += text;
      if (pending.length > maxLineBytes + 1_048_576) {
        throw fail("replay fixture line exceeds the size bound");
      }
      let index = pending.indexOf("\n");
      while (index !== -1) {
        lineNumber += 1;
        const raw = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (raw.length > maxLineBytes) {
          throw fail(`replay fixture line ${lineNumber} exceeds the size bound`);
        }
        if (raw.length > 0) {
          yield JSON.parse(raw) as unknown;
        }
        index = pending.indexOf("\n");
      }
    }
  } catch (thrown: unknown) {
    if (thrown instanceof SyntaxError) {
      throw fail(`replay fixture line ${lineNumber + 1} is not valid JSON`);
    }
    if (
      typeof thrown === "object" &&
      thrown !== null &&
      (thrown as { code?: unknown }).code === "ENOENT"
    ) {
      throw fail(`cannot read replay fixture ${path}`);
    }
    throw thrown;
  }
  const tail = pending.trim();
  if (tail.length > 0) {
    lineNumber += 1;
    if (tail.length > maxLineBytes) {
      throw fail(`replay fixture line ${lineNumber} exceeds the size bound`);
    }
    try {
      yield JSON.parse(tail) as unknown;
    } catch {
      throw fail(`replay fixture line ${lineNumber} is not valid JSON`);
    }
  }
}

export function openLineSource(path: string, maxLineBytes = DEFAULT_MAX_LINE_BYTES): LineSource {
  const stream = createReadStream(path, { encoding: "utf8" });
  let disposed = false;
  return {
    events: readLines(path, stream, maxLineBytes),
    dispose: async (): Promise<void> => {
      if (!disposed) {
        disposed = true;
        stream.destroy();
      }
    },
  };
}
