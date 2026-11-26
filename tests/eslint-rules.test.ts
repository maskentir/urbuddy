import { createRequire } from "node:module";

import tsParser from "@typescript-eslint/parser";
import { type Rule, RuleTester } from "eslint";
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
  it("accepts directives and categorized why-statements, rejects the rest", () => {
    ruleTester.run("no-redundant-comments", rule("no-redundant-comments"), {
      valid: [
        "const enabled = true;",
        "// eslint-disable-next-line no-control-regex",
        "/* eslint-enable no-control-regex */",
        "/** [correctness] Never throws, so callers need no nested try. */\nexport const keep = 1;",
        "/** [security] Name-based redaction only; unknown keys pass through. */\nexport const kept = 1;",
        "/** [legal] Third-party license requires this notice. */\nexport const licensed = 1;",
        "/** [protocol] The endpoint requires this exact header order. */\nexport const wired = 1;",
        "/** [tooling] The bundler reads this marker comment. */\nexport const marked = 1;",
      ],
      invalid: [
        {
          code: "// narrate the next line",
          errors: [{ message: "Line comments are prohibited; express it in code." }],
        },
        {
          code: "/** Repeat what the code already says. */\nexport const x = 1;",
          errors: [{ message: /\[correctness\|security\|legal\|protocol\|tooling\] marker/ }],
        },
        {
          code: "/** [performance] Faster this way. */\nexport const y = 1;",
          errors: [{ message: /\[correctness\|security\|legal\|protocol\|tooling\] marker/ }],
        },
      ],
    });
  });
});

describe("urbuddy/canonical-imports", () => {
  it("accepts canonical specifiers and rejects the rest", () => {
    ruleTester.run("canonical-imports", rule("canonical-imports"), {
      valid: [
        {
          code: 'import { join } from "node:path";',
          filename: `${process.cwd()}/src/kernel/probe.ts`,
        },
        {
          code: 'import { err } from "neverthrow";',
          filename: `${process.cwd()}/src/kernel/probe.ts`,
        },
        {
          code: 'import type { AppError } from "@kernel/errors";',
          filename: `${process.cwd()}/src/kernel/probe.ts`,
        },
        {
          code: 'import { ok } from "./errors.js";',
          filename: `${process.cwd()}/src/kernel/probe.ts`,
        },
        {
          code: 'import { x } from "@kernel/ids";',
          filename: `${process.cwd()}/tests/probe.test.ts`,
        },
        {
          code: 'import { describe, it } from "vitest";',
          filename: `${process.cwd()}/tests/probe.test.ts`,
        },
      ],
      invalid: [
        {
          code: 'import { join } from "path";',
          filename: `${process.cwd()}/src/kernel/probe.ts`,
          errors: [{ message: 'Built-in import "path" must use the node: prefix.' }],
        },
        {
          code: 'import { x } from "@kernel/errors.js";',
          filename: `${process.cwd()}/src/kernel/probe.ts`,
          errors: [{ message: /extensionless/ }],
        },
        {
          code: 'import { x } from "@kernel/internal/ids";',
          filename: `${process.cwd()}/src/kernel/probe.ts`,
          errors: [{ message: /Private deep import/ }],
        },
        {
          code: 'import { ok } from "./errors.js";',
          filename: `${process.cwd()}/tests/probe.test.ts`,
          errors: [
            { message: 'Tests must import src through canonical @ aliases, not "./errors.js".' },
          ],
        },
      ],
    });
  });
});
