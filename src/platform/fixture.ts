import { once } from "node:events";
import { open, type FileHandle } from "node:fs/promises";

import { appError, type AppError } from "@kernel/errors";
import { err, ok, type Result } from "neverthrow";

export interface LineSource {
  readonly events: AsyncIterable<unknown>;
  dispose(): Promise<void>;
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
  try {
    for await (const chunk of stream) {
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
    if (
      typeof thrown === "object" &&
      thrown !== null &&
      (thrown as { code?: unknown }).code === "ENOENT"
    ) {
      throw fixtureFailure("cannot read replay fixture");
    }
    throw thrown;
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
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
): Promise<Result<LineSource, AppError>> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return err(fixtureFailure("cannot read replay fixture"));
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close().catch(() => undefined);
      return err(fixtureFailure("replay fixture must be a regular file"));
    }
  } catch {
    await handle.close().catch(() => undefined);
    return err(fixtureFailure("cannot read replay fixture"));
  }
  const stream = handle.createReadStream();
  let disposed = false;
  return ok({
    events: readLines(stream, maxLineBytes),
    dispose: async (): Promise<void> => {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        if (!stream.destroyed) {
          stream.destroy();
          await once(stream, "close");
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  });
}
