import { fileURLToPath } from "node:url";

import { runApp } from "./composition.js";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return runApp(argv, env);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const code = await main(process.argv, process.env);
  process.exitCode = code;
}
