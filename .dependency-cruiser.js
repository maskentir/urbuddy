export default {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular imports hide lifecycle ownership; restructure instead.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "error",
      comment:
        "Every src module must be reachable from the composition root. " +
        "No speculative modules: delete what main.ts cannot reach.",
      from: { orphan: true, pathNot: ["src/bootstrap/main\\.ts$"] },
      to: {},
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Imports must resolve under NodeNext.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "not-to-dev",
      severity: "error",
      comment: "Production code must not depend on devDependencies.",
      from: { path: "^src" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "kernel-boundary",
      severity: "error",
      comment: "Kernel is the bottom layer; it imports nothing above itself.",
      from: { path: "^src/kernel" },
      to: { path: "^(src/modules|src/platform|src/presentation|src/bootstrap)" },
    },
    {
      name: "platform-boundary",
      severity: "error",
      comment: "Platform wraps the outside world; it never imports domain or UI layers.",
      from: { path: "^src/platform" },
      to: { path: "^(src/modules|src/presentation|src/bootstrap)" },
    },
    {
      name: "modules-boundary",
      severity: "error",
      comment: "Domain modules never import presentation or bootstrap.",
      from: { path: "^src/modules" },
      to: { path: "^(src/presentation|src/bootstrap)" },
    },
    {
      name: "presentation-boundary",
      severity: "error",
      comment: "Presentation is wired only by the bootstrap composition root.",
      from: { path: "^src/presentation" },
      to: { path: "^src/bootstrap" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    includeOnly: "^src",
    tsConfig: { fileName: "tsconfig.json" },
    webpackConfig: { fileName: "webpack.cruise.cjs" },
  },
};
