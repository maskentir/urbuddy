import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

const tsconfig = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8"));
const patterns = Object.keys(tsconfig.compilerOptions.paths ?? {});
const prefixes = patterns.map((pattern) => pattern.replace(/\/\*$/, ""));

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else if (full.endsWith(".js")) {
      out.push(full);
    }
  }
  return out.sort();
}

function specifiersOf(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const failures = [];
if (!existsSync(dist)) {
  failures.push("dist/ is missing: run pnpm build first");
} else {
  const files = collectFiles(dist);
  if (files.length === 0) {
    failures.push("dist/ contains no JavaScript output");
  }
  for (const file of files) {
    const relative = file.slice(dist.length + 1);
    for (const specifier of specifiersOf(file)) {
      for (const prefix of prefixes) {
        if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
          failures.push(`${relative}: unresolved canonical alias: ${specifier}`);
        }
      }
      if (
        specifier.startsWith("src/") ||
        specifier.startsWith("dist/") ||
        specifier.startsWith("/")
      ) {
        failures.push(`${relative}: source-tree specifier in compiled output: ${specifier}`);
      } else if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (!existsSync(target)) {
          failures.push(`${relative}: dangling relative import: ${specifier}`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`verify-dist: ${failure}\n`);
  }
  process.exit(1);
}
process.stdout.write(
  `verify-dist: ${prefixes.length} canonical aliases checked (${prefixes.join(", ")}), no unresolved or source-tree specifiers\n`,
);
