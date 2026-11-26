const { builtinModules } = require("node:module");
const path = require("node:path");

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const ALIAS_SCOPES = [
  "@kernel",
  "@modules",
  "@platform",
  "@adapters",
  "@presentation",
  "@bootstrap",
];

function innerText(comment) {
  return comment
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

function isAliasSpecifier(specifier) {
  return ALIAS_SCOPES.some((scope) => specifier === scope || specifier.startsWith(`${scope}/`));
}

function underTests(filename, root) {
  return path.relative(root, filename).split(path.sep)[0] === "tests";
}

const COMMENT_CATEGORIES = ["correctness", "security", "legal", "protocol", "tooling"];

function commentCategory(text) {
  const inner = innerText(text);
  const match = /^\[([a-z]+)\]/.exec(inner);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  return COMMENT_CATEGORIES.includes(match[1]) ? match[1] : undefined;
}

const noRedundantComments = {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid comments except categorized why-statements and tooling directives.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const source = context.sourceCode;
        for (const comment of source.getAllComments()) {
          if (/^eslint-(disable|enable)\b/.test(comment.value.trim())) {
            continue;
          }
          if (comment.type === "Line") {
            context.report({
              node: comment,
              message: "Line comments are prohibited; express it in code.",
            });
            continue;
          }
          if (commentCategory(comment.value) === undefined) {
            context.report({
              node: comment,
              message:
                "Block comments need a [correctness|security|legal|protocol|tooling] marker with a why-justification.",
            });
          }
        }
      },
    };
  },
};

const canonicalImports = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce node: prefixes, extensionless aliases, and in-module relative imports.",
    },
    schema: [],
  },
  create(context) {
    const root = context.cwd ?? process.cwd();
    return {
      ImportDeclaration(node) {
        const specifier = node.source.value;
        if (typeof specifier !== "string") {
          return;
        }
        if (BUILTINS.has(specifier) && !specifier.startsWith("node:")) {
          context.report({
            node: node.source,
            message: `Built-in import "${specifier}" must use the node: prefix.`,
          });
          return;
        }
        if (isAliasSpecifier(specifier)) {
          if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(specifier)) {
            context.report({
              node: node.source,
              message: `Alias import "${specifier}" must be extensionless.`,
            });
          }
          for (const segment of specifier.split("/")) {
            if (segment === "internal" || segment.startsWith("_")) {
              context.report({
                node: node.source,
                message: `Private deep import "${specifier}" is forbidden.`,
              });
              return;
            }
          }
          return;
        }
        if (underTests(context.filename, root)) {
          if (specifier.startsWith(".")) {
            context.report({
              node: node.source,
              message: `Tests must import src through canonical @ aliases, not "${specifier}".`,
            });
          }
          return;
        }
      },
    };
  },
};

module.exports = {
  rules: { "no-redundant-comments": noRedundantComments, "canonical-imports": canonicalImports },
};
