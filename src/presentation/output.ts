import { once } from "node:events";
import type { Writable } from "node:stream";

export interface CliOutput {
  out(line: string): void | Promise<void>;
  errLine(line: string): void | Promise<void>;
}

export function createStreamOutput(stdout: Writable, stderr: Writable): CliOutput {
  const write = async (stream: Writable, line: string): Promise<void> => {
    if (!stream.write(`${line}\n`)) {
      await once(stream, "drain");
    }
  };
  return {
    out: (line: string) => write(stdout, line),
    errLine: (line: string) => write(stderr, line),
  };
}
