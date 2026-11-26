import type { Writable } from "node:stream";

export interface CliOutput {
  out(line: string): void | Promise<void>;
  errLine(line: string): void | Promise<void>;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("operation aborted");
}

function waitDrain(stream: Writable, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (thrown: unknown): void => {
      cleanup();
      reject(thrown instanceof Error ? thrown : new Error("output stream error"));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("output stream closed before drain"));
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal as AbortSignal));
    };
    if (signal !== undefined && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createStreamOutput(
  stdout: Writable,
  stderr: Writable,
  signal?: AbortSignal,
): CliOutput {
  const write = async (stream: Writable, line: string): Promise<void> => {
    if (signal !== undefined && signal.aborted) {
      throw abortError(signal);
    }
    if (stream.destroyed || stream.writableEnded) {
      throw new Error("output stream closed");
    }
    if (!stream.write(`${line}\n`)) {
      await waitDrain(stream, signal);
    }
  };
  return {
    out: (line: string) => write(stdout, line),
    errLine: (line: string) => write(stderr, line),
  };
}
