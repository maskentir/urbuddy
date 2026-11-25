import { createRequire } from "node:module";

import tseslint from "typescript-eslint";

const require = createRequire(import.meta.url);
const importX = require("eslint-plugin-import-x");

const urbuddy = require("./tooling/eslint-plugin-urbuddy.cjs");

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["webpack.cruise.cjs", "tooling/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    plugins: {
      "import-x": importX,
      urbuddy,
    },
    rules: {
      "import-x/no-duplicates": "error",
      "import-x/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          pathGroups: [
            {
              pattern: "@*/**",
              group: "internal",
              position: "before",
            },
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc" },
        },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "urbuddy/no-redundant-comments": [
        "error",
        {
          allowed: [
            "Never throws, so catch blocks can convert without nesting further try blocks.",
            "Handlers run in subscription order.",
            "Name-based redaction only: values under unrecognized keys pass through, so callers must not log raw payloads.",
          ],
        },
      ],
      "urbuddy/canonical-imports": "error",
    },
  },
);
