import { createRequire } from "node:module";

import tsParser from "@typescript-eslint/parser";
import { RuleTester, type Rule } from "eslint";
import { describe, it } from "vitest";

const require = createRequire(import.meta.url);
const plugin = require("../tooling/eslint-plugin-urbuddy.cjs") as {
  rules: Record<string, Rule.RuleModule | undefined>;
};

function rule(name: "no-redundant-comments" | "canonical-imports"): Rule.RuleModule {
  const found = plugin.rules[name];
  if (found === undefined) {
    throw new Error(`missing rule fixture: ${name}`);
  }
  return found;
}

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser },
});

describe("urbuddy/no-redundant-comments", () => {
  it("accepts code, directives, and registered exceptions", () => {
    ruleTester.run("no-redundant-comments", rule("no-redundant-comments"), {
      valid: [
        "const enabled = true;",
        "// eslint-disable-next-line no-control-regex",
        "/* eslint-enable no-control-regex */",
        {
          code: "/** Handlers run in subscription order. */\nexport const keep = 1;",
          options: [{ allowed: ["Handlers run in subscription order."] }],
        },
      ],
      invalid: [
        {
          code: "// narrate the next line",
          errors: [{ message: "Line comments are prohibited; express it in code." }],
        },
        {
          code: "/* repeat what the code says */\nexport const x = 1;",
          errors: [{ message: "Unregistered block comment; use code or register the exception." }],
        },
      ],
    });
  });
});

describe("urbuddy/canonical-imports", () => {
  it("accepts canonical specifiers and rejects the rest", () => {
    const filename = `${process.cwd()}/src/kernel/probe.ts`;
    ruleTester.run("canonical-imports", rule("canonical-imports"), {
      valid: [
        { code: 'import { join } from "node:path";', filename },
        { code: 'import { err } from "neverthrow";', filename },
        { code: 'import type { AppError } from "@kernel/errors";', filename },
        { code: 'import { ok } from "./errors.js";', filename },
      ],
      invalid: [
        {
          code: 'import { join } from "path";',
          filename,
          errors: [{ message: 'Builtin import "path" must use the node: prefix.' }],
        },
        {
          code: 'import { x } from "src/kernel/ids";',
          filename,
          errors: [{ message: /Source-tree specifier/ }],
        },
        {
          code: 'import { x } from "@kernel/internal/ids";',
          filename,
          errors: [{ message: /Private deep import/ }],
        },
        {
          code: 'import { x } from "../platform/paths.js";',
          filename,
          errors: [{ message: /escapes kernel/ }],
        },
        {
          code: 'import { ok } from "./errors.js";',
          filename: `${process.cwd()}/tests/probe.test.ts`,
          errors: [{ message: /must use a canonical @ alias/ }],
        },
      ],
    });
  });
});
