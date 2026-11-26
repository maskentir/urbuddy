import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

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

async function acquireFixture(path: string): Promise<Result<FileHandle, AppError>> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
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
  return ok(handle);
}

export async function openFingerprintedFixture(
  path: string,
  options: LineSourceOptions = {},
): Promise<Result<{ fingerprint: string; source: LineSource }, AppError>> {
  const acquired = await acquireFixture(path);
  if (acquired.isErr()) {
    return err(acquired.error);
  }
  const handle = acquired.value;
  const hash = createHash("sha256");
  const hashStream = handle.createReadStream({ start: 0, autoClose: false });
  const onAbort = (): void => {
    hashStream.destroy();
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      hashStream.destroy();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  try {
    for await (const chunk of hashStream) {
      hash.update(chunk as Buffer);
    }
  } catch {
    await handle.close().catch(() => undefined);
    return err(fixtureFailure("cannot read replay fixture"));
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (options.signal?.aborted === true) {
    await handle.close().catch(() => undefined);
    return err(appError("CANCELLED", "replay cancelled"));
  }
  const source = lineSourceFromHandle(handle, options);
  return ok({ fingerprint: hash.digest("hex"), source });
}

export async function openLineSource(
  path: string,
  options: LineSourceOptions = {},
): Promise<Result<LineSource, AppError>> {
  const acquired = await acquireFixture(path);
  if (acquired.isErr()) {
    return err(acquired.error);
  }
  return ok(lineSourceFromHandle(acquired.value, options));
}

function lineSourceFromHandle(handle: FileHandle, options: LineSourceOptions): LineSource {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
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
  return {
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
  };
}
