import { once } from "node:events";
import { open, stat, type FileHandle } from "node:fs/promises";

import { appError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

export interface LineSource {
  readonly events: AsyncIterable<unknown>;
  dispose(): Promise<void>;
}

export interface LineSourceOptions {
  readonly maxLineBytes?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_MAX_LINE_BYTES = 1_048_576;

function fixtureFailure(message: string): AppError {
  return appError("VALIDATION_FAILED", message);
}

async function* readLines(
  stream: AsyncIterable<Buffer>,
  maxLineBytes: number,
): AsyncGenerator<unknown, void, void> {
  let pending = Buffer.alloc(0);
  let lineNumber = 0;
  const newline = 0x0a;
  const parseLine = (raw: Buffer, number: number): unknown => {
    let line = raw;
    if (line.length > 0 && line[line.length - 1] === 0x0d) {
      line = line.subarray(0, line.length - 1);
    }
    if (line.length > maxLineBytes) {
      throw fixtureFailure(`replay fixture line ${number} exceeds the size bound`);
    }
    const text = line.toString("utf8").trim();
    if (text.length === 0) {
      return undefined;
    }
    if (Buffer.byteLength(text, "utf8") > maxLineBytes) {
      throw fixtureFailure(`replay fixture line ${number} exceeds the size bound`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw fixtureFailure(`replay fixture line ${number} is not valid JSON`);
    }
  };
  const iterator = stream[Symbol.asyncIterator]();
  let failure: unknown;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        break;
      }
      const chunk = next.value;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      pending = Buffer.concat([pending, buffer]);
      if (pending.length > maxLineBytes + 65_536) {
        throw fixtureFailure(`replay fixture line ${lineNumber + 1} exceeds the size bound`);
      }
      let index = pending.indexOf(newline);
      while (index !== -1) {
        lineNumber += 1;
        const raw = pending.subarray(0, index);
        pending = pending.subarray(index + 1);
        const parsed = parseLine(raw, lineNumber);
        if (parsed !== undefined) {
          yield parsed;
        }
        index = pending.indexOf(newline);
      }
    }
  } catch (thrown: unknown) {
    failure = thrown;
  }
  if (typeof iterator.return === "function") {
    await iterator.return().catch(() => undefined);
  }
  if (failure !== undefined) {
    if (
      typeof failure === "object" &&
      failure !== null &&
      (failure as { code?: unknown }).code === "ENOENT"
    ) {
      throw fixtureFailure("cannot read replay fixture");
    }
    throw failure;
  }
  if (pending.length > 0) {
    lineNumber += 1;
    const parsed = parseLine(pending, lineNumber);
    if (parsed !== undefined) {
      yield parsed;
    }
  }
}

export async function openLineSource(
  path: string,
  options: LineSourceOptions = {},
): Promise<Result<LineSource, AppError>> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  let handle: FileHandle;
  try {
    const before = await stat(path);
    if (!before.isFile()) {
      return err(fixtureFailure("replay fixture must be a regular file"));
    }
    handle = await open(path, "r");
  } catch {
    return err(fixtureFailure("cannot read replay fixture"));
  }
  try {
    const after = await handle.stat();
    if (!after.isFile()) {
      await handle.close().catch(() => undefined);
      return err(fixtureFailure("replay fixture must be a regular file"));
    }
  } catch {
    await handle.close().catch(() => undefined);
    return err(fixtureFailure("cannot read replay fixture"));
  }
  const stream = handle.createReadStream();
  const onAbort = (): void => {
    stream.destroy();
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      stream.destroy();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  let disposed = false;
  return ok({
    events: readLines(stream, maxLineBytes),
    dispose: async (): Promise<void> => {
      if (disposed) {
        return;
      }
      disposed = true;
      options.signal?.removeEventListener("abort", onAbort);
      let firstError: unknown;
      if (!stream.closed) {
        const closed = once(stream, "close").catch((thrown: unknown) => {
          if (!stream.closed) {
            firstError ??= thrown;
          }
        });
        stream.destroy();
        await closed;
        if (!stream.closed && firstError === undefined) {
          firstError = new Error("fixture stream did not close");
        }
      }
      try {
        await handle.close();
      } catch (thrown: unknown) {
        firstError ??= thrown;
      }
      if (firstError !== undefined) {
        throw firstError;
      }
    },
  });
}
