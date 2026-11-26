const path = require("node:path");

const tsconfig = require("./tsconfig.json");

const root = __dirname;
const alias = {};
for (const [key, targets] of Object.entries(tsconfig.compilerOptions.paths ?? {})) {
  const name = key.replace(/\/\*$/, "");
  const target = targets[0].replace(/\/\*(\.js)?$/, "");
  alias[name] = path.resolve(root, target);
}

module.exports = {
  resolve: {
    alias,
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
    },
  },
};
