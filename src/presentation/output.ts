import type { Writable } from "node:stream";

export interface CliOutput {
  out(line: string): void | Promise<void>;
  errLine(line: string): void | Promise<void>;
}

interface StreamState {
  failure: unknown;
}

const streamStates = new WeakMap<Writable, StreamState>();

function stateFor(stream: Writable): StreamState {
  const existing = streamStates.get(stream);
  if (existing !== undefined) {
    return existing;
  }
  const created: StreamState = { failure: undefined };
  streamStates.set(stream, created);
  stream.on("error", (thrown: unknown) => {
    created.failure ??= thrown;
  });
  return created;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("operation aborted");
}

function writeChunk(
  stream: Writable,
  state: StreamState,
  line: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      stream.off("error", onError);
      stream.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (action: () => void): void => {
      if (!settled) {
        settled = true;
        cleanup();
        action();
      }
    };
    const onError = (thrown: unknown): void => {
      settle(() => reject(thrown instanceof Error ? thrown : new Error("output stream error")));
    };
    const onClose = (): void => {
      settle(() => reject(new Error("output stream closed before write completed")));
    };
    const onAbort = (): void => {
      settle(() => reject(abortError(signal as AbortSignal)));
    };
    if (state.failure !== undefined) {
      reject(state.failure instanceof Error ? state.failure : new Error("output stream error"));
      return;
    }
    if (signal !== undefined && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    if (stream.destroyed || stream.writableEnded) {
      reject(new Error("output stream closed"));
      return;
    }
    stream.once("error", onError);
    stream.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.write(`${line}\n`, (thrown) => {
      if (thrown !== undefined && thrown !== null) {
        settle(() => reject(thrown));
      } else {
        settle(() => resolve());
      }
    });
  });
}

export function createStreamOutput(
  stdout: Writable,
  stderr: Writable,
  signal?: AbortSignal,
): CliOutput {
  const write = async (stream: Writable, line: string): Promise<void> => {
    const state = stateFor(stream);
    await writeChunk(stream, state, line, signal);
    if (state.failure !== undefined) {
      throw state.failure instanceof Error ? state.failure : new Error("output stream error");
    }
  };
  return {
    out: (line: string) => write(stdout, line),
    errLine: (line: string) => write(stderr, line),
  };
}
