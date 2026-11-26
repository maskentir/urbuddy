import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(resolve(root, name), "utf8")) as unknown;
}

describe("single source of truth", () => {
  it("pins pnpm with a single lockfile", () => {
    const pkg = readJson("package.json") as { packageManager?: string; imports?: unknown };
    expect(pkg.packageManager?.startsWith("pnpm@")).toBe(true);
    expect(pkg.imports, "obsolete native # mappings must stay removed").toBeUndefined();
    expect(existsSync(resolve(root, "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(resolve(root, "package-lock.json"))).toBe(false);
  });

  it("declares every canonical alias exactly once", () => {
    const tsconfig = readJson("tsconfig.json") as {
      compilerOptions?: { paths?: Record<string, readonly string[]> };
    };
    expect(Object.keys(tsconfig.compilerOptions?.paths ?? {}).sort()).toEqual([
      "@adapters/*",
      "@bootstrap/*",
      "@kernel/*",
      "@modules/*",
      "@platform/*",
      "@presentation/*",
    ]);
    const cruise = readFileSync(resolve(root, "webpack.cruise.cjs"), "utf8");
    expect(cruise.includes("tsconfig.json")).toBe(true);
  });
});
