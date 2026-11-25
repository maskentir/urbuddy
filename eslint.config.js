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
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["src/**", "dist/**"],
              message:
                "Import through canonical @ aliases or owning-module relative imports instead.",
            },
          ],
        },
      ],
      "urbuddy/no-redundant-comments": "error",
      "urbuddy/canonical-imports": "error",
    },
  },
);
