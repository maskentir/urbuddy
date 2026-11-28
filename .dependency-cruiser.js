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
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Imports must resolve under NodeNext.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "production-does-not-depend-on-lab",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^lab/" },
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
      comment:
        "Platform wraps the outside world; it never imports domain or UI layers, except type-only application ports it implements.",
      from: { path: "^src/platform" },
      to: {
        path: "^(src/modules|src/presentation|src/bootstrap)",
        pathNot: "^src/modules/session/persistence",
      },
    },
    {
      name: "platform-port-type-only",
      severity: "error",
      comment: "Platform implementations may reference application ports only as types.",
      from: { path: "^src/platform" },
      to: {
        path: "^src/modules/session/persistence",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "modules-boundary",
      severity: "error",
      comment: "Domain modules never import presentation, bootstrap, or platform internals.",
      from: { path: "^src/modules" },
      to: { path: "^(src/presentation|src/bootstrap|src/platform)" },
    },
    {
      name: "modules-config-owns-itself",
      severity: "error",
      comment: "Configuration owns its contracts; security consumes them, never the reverse.",
      from: { path: "^src/modules/config" },
      to: { path: "^src/modules/security" },
    },
    {
      name: "presentation-boundary",
      severity: "error",
      comment: "Presentation is wired only by the bootstrap composition root.",
      from: { path: "^src/presentation" },
      to: { path: "^src/bootstrap" },
    },
    {
      name: "adapters-boundary",
      severity: "error",
      comment:
        "Adapters translate vendor APIs into kernel contracts; they never import domain, UI, or composition layers.",
      from: { path: "^src/adapters" },
      to: {
        path: "^(src/modules|src/presentation|src/bootstrap)",
        pathNot: "^src/modules/(perception/(audio|speech|convert)|language/translation)",
      },
    },
    {
      name: "adapters-port-type-only",
      severity: "error",
      comment:
        "Adapters may implement public application-owned ports, but only as types; values stay domain-owned.",
      from: { path: "^src/adapters" },
      to: {
        path: "^src/modules/(perception/(audio|speech|convert)|language/translation)",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "adapters-owned-by-bootstrap",
      severity: "error",
      comment: "Only the composition root wires adapters; no other layer reaches past them.",
      from: { path: "^(src/kernel|src/modules|src/platform|src/presentation)" },
      to: { path: "^src/adapters" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    includeOnly: "^(src|lab)/",
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    webpackConfig: { fileName: "webpack.cruise.cjs" },
  },
};
