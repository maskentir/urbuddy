const { builtinModules } = require("node:module");
const path = require("node:path");

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function innerText(commentText) {
  return commentText
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

function componentOf(filename, root) {
  const relative = path.relative(root, filename).split(path.sep);
  if (relative[0] !== "src" || relative.length < 2) {
    return undefined;
  }
  return relative[1];
}

const noRedundantComments = {
  meta: {
    type: "problem",
    docs: { description: "Forbid redundant comments; allowlisted why-statements only." },
    schema: [
      {
        type: "object",
        properties: { allowed: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowed: [] }],
  },
  create(context) {
    const allowed = new Set((context.options[0]?.allowed ?? []).map(innerText));
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
          } else if (!allowed.has(innerText(comment.value))) {
            context.report({
              node: comment,
              message: "Unregistered block comment; use code or register the exception.",
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
    docs: { description: "Enforce canonical alias, node:, and in-module relative imports." },
    schema: [],
  },
  create(context) {
    const filename = context.filename;
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
            message: `Builtin import "${specifier}" must use the node: prefix.`,
          });
          return;
        }
        if (
          specifier.startsWith("src/") ||
          specifier.startsWith("dist/") ||
          specifier.startsWith("/") ||
          specifier === "../src" ||
          specifier.startsWith("../src/")
        ) {
          context.report({
            node: node.source,
            message: `Source-tree specifier "${specifier}" is forbidden; use a canonical @ alias.`,
          });
          return;
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
        if (!specifier.startsWith(".")) {
          return;
        }
        const owner = componentOf(filename, root);
        if (owner === undefined) {
          context.report({
            node: node.source,
            message: `Relative import "${specifier}" outside src must use a canonical @ alias.`,
          });
          return;
        }
        const target = path.normalize(path.join(path.dirname(filename), specifier));
        const boundary = path.join(root, "src", owner) + path.sep;
        if (target !== boundary.slice(0, -1) && !target.startsWith(boundary)) {
          context.report({
            node: node.source,
            message: `Relative import "${specifier}" escapes ${owner}; use a canonical @ alias.`,
          });
        }
      },
    };
  },
};

module.exports = {
  rules: { "no-redundant-comments": noRedundantComments, "canonical-imports": canonicalImports },
};
