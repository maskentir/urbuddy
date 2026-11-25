import { readFileSync } from "node:fs";

import {
  createAppContainer,
  isAppContainer,
  runApp,
  startApp,
  stopApp,
  trackResource,
} from "@bootstrap/composition";
import { URBUDDY_VERSION } from "@bootstrap/version";
import { fixedClock } from "@kernel/clock";
import { appError, formatError } from "@kernel/errors";
import { EXIT_CODES, type ExitCodeName } from "@kernel/exit-codes";
import { createDeterministicIdGenerator } from "@kernel/ids";
import {
  type buildDoctorReport,
  createProgram,
  exitCodeForError,
  extractGlobalFlags,
  nodeMajor,
  runCli,
  runDoctorChecks,
  type CliDeps,
  type CliOutput,
  type DoctorCheck,
} from "@presentation/cli";
import { runInkSmoke, startupMessageText } from "@presentation/ink-smoke";
import { describe, expect, it } from "vitest";

function testDeps(): CliDeps {
  const created = createAppContainer({
    env: {},
    ids: createDeterministicIdGenerator("cli"),
    clock: fixedClock(0),
  });
  if (!isAppContainer(created)) {
    throw new Error("fixture container must build");
  }
  return {
    version: URBUDDY_VERSION,
    config: created.config,
    paths: created.paths,
    sessionId: created.sessionId,
    correlationId: created.correlationId,
    nowIso: created.clock.isoNow(),
  };
}

function capture(): { output: CliOutput; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    output: {
      out: (line: string) => {
        lines.push(line);
      },
      errLine: (line: string) => {
        errors.push(line);
      },
    },
  };
}

describe("cli flags", () => {
  it("extracts spaced, inline, and boolean globals", () => {
    expect(
      extractGlobalFlags([
        "node",
        "urbuddy",
        "--profile",
        "simulation",
        "--log-level=debug",
        "--allow-egress",
      ]),
    ).toEqual({ profile: "simulation", logLevel: "debug", allowNetworkEgress: true });
    expect(extractGlobalFlags(["--allow-child"])).toEqual({ allowChildProcesses: true });
    expect(extractGlobalFlags(["doctor", "--json"])).toEqual({});
  });
});

describe("exit codes", () => {
  it("maps every error code to the catalog", () => {
    expect(exitCodeForError(appError("CONFIG_INVALID", "x"))).toBe(EXIT_CODES.configError);
    expect(exitCodeForError(appError("VALIDATION_FAILED", "x"))).toBe(EXIT_CODES.usage);
    expect(exitCodeForError(appError("RESOURCE_ACQUIRE_FAILED", "x"))).toBe(
      EXIT_CODES.generalError,
    );
    expect(exitCodeForError(appError("RESOURCE_RELEASE_FAILED", "x"))).toBe(
      EXIT_CODES.generalError,
    );
    expect(exitCodeForError(appError("CANCELLED", "x"))).toBe(EXIT_CODES.cancelled);
    expect(exitCodeForError(appError("UNSUPPORTED", "x"))).toBe(EXIT_CODES.usage);
    expect(exitCodeForError(appError("INTERNAL", "x"))).toBe(EXIT_CODES.generalError);
  });

  it("parses node majors", () => {
    expect(nodeMajor("v26.5.1")).toBe(26);
    expect(nodeMajor("22.0.0")).toBe(22);
    expect(nodeMajor("bogus")).toBeUndefined();
  });
});

describe("cli commands", () => {
  it("version prints the build version", async () => {
    const captured = capture();
    const code = await runCli(["node", "urbuddy", "version"], testDeps(), captured.output);
    expect(code).toBe(EXIT_CODES.success);
    expect(captured.lines.join("\n")).toContain(URBUDDY_VERSION);
  });

  it("doctor --json emits a parseable passing report", async () => {
    const captured = capture();
    const code = await runCli(["node", "urbuddy", "doctor", "--json"], testDeps(), captured.output);
    expect(code).toBe(EXIT_CODES.success);
    const report = JSON.parse(captured.lines.join("\n")) as ReturnType<typeof buildDoctorReport>;
    expect(report.app).toBe("urbuddy");
    expect(report.version).toBe(URBUDDY_VERSION);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      "node-runtime",
      "app-paths",
      "session-config",
    ]);
  });

  it("doctor text mode is human readable", async () => {
    const captured = capture();
    const code = await runCli(["node", "urbuddy", "doctor"], testDeps(), captured.output);
    expect(code).toBe(EXIT_CODES.success);
    expect(captured.lines.join("\n")).toContain("status: ok");
  });

  it("help lists the catalog and unknown commands are usage errors", async () => {
    const captured = capture();
    const helpCode = await runCli(["node", "urbuddy", "--help"], testDeps(), captured.output);
    expect(helpCode).toBe(EXIT_CODES.success);
    expect(captured.lines.join("\n")).toContain("doctor");
    const unknown = await runCli(["node", "urbuddy", "bogus"], testDeps(), capture().output);
    expect(unknown).toBe(EXIT_CODES.usage);
  });

  it("failing doctor surfaces its error for the caller to map", async () => {
    const deps = testDeps();
    const bad: CliDeps = {
      ...deps,
      paths: { data: "", config: "", cache: "", log: "", temp: "" },
    };
    await expect(
      runCli(["node", "urbuddy", "doctor"], bad, capture().output),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("program help mentions global flags", () => {
    const program = createProgram(testDeps(), capture().output);
    expect(program.helpInformation()).toContain("--profile");
  });
});

describe("ink smoke", () => {
  it("builds the startup message and passes dry runs", async () => {
    expect(startupMessageText("0.0.0", "s-1")).toBe("urbuddy 0.0.0 ready (session s-1)");
    const result = await runInkSmoke({ version: "0.0.0", sessionId: "s-1", dryRun: true });
    expect(result.isOk()).toBe(true);
  });
});

describe("doctor checks", () => {
  it("reports one entry per check with exit-code names covered", () => {
    const checks: DoctorCheck[] = runDoctorChecks(testDeps());
    expect(checks.map((check) => check.name)).toEqual([
      "node-runtime",
      "app-paths",
      "session-config",
    ]);
    const okName: ExitCodeName = "success";
    expect(EXIT_CODES[okName]).toBe(0);
  });
});

describe("composition", () => {
  it("rejects configs that violate profile guards", () => {
    const created = createAppContainer({
      env: {},
      flags: { profile: "offline", allowNetworkEgress: true },
    });
    expect(isAppContainer(created)).toBe(false);
  });

  it("tracks resources and releases them on stop", async () => {
    const created = createAppContainer({
      env: {},
      ids: createDeterministicIdGenerator("app"),
      clock: fixedClock(1000),
    });
    if (!isAppContainer(created)) {
      throw new Error("fixture container must build");
    }
    startApp(created);
    let released = false;
    expect(
      trackResource(created, {
        id: created.ids.resourceId(),
        kind: "timer",
        dispose: () => {
          released = true;
          return Promise.resolve();
        },
      }),
    ).toBe(true);
    const stopped = await stopApp(created, { exitCode: EXIT_CODES.success });
    expect(stopped.error).toBeUndefined();
    expect(released).toBe(true);
  });

  it("runApp serves doctor and rejects bad profiles with the config exit code", async () => {
    expect(await runApp(["node", "urbuddy", "doctor", "--json"], {})).toBe(EXIT_CODES.success);
    expect(await runApp(["node", "urbuddy", "doctor"], { URBUDDY_PROFILE: "nope" })).toBe(
      EXIT_CODES.configError,
    );
  });
});

describe("security enforcement", () => {
  it("offline profile rejects egress grants before anything runs", async () => {
    const code = await runApp(
      ["node", "urbuddy", "doctor", "--profile", "offline", "--allow-egress"],
      {},
    );
    expect(code).toBe(EXIT_CODES.configError);
  });

  it("strips escape sequences from environment-supplied values", async () => {
    const created = createAppContainer({
      env: { URBUDDY_DATA_ROOT: "\u001b]0;pwned\u0007/tmp\nstatus: ok" },
      ids: createDeterministicIdGenerator("sec"),
      clock: fixedClock(0),
    });
    if (!isAppContainer(created)) {
      throw new Error("fixture container must build");
    }
    const captured = capture();
    const code = await runCli(
      ["node", "urbuddy", "doctor"],
      {
        version: URBUDDY_VERSION,
        config: created.config,
        paths: created.paths,
        sessionId: created.sessionId,
        correlationId: created.correlationId,
        nowIso: created.clock.isoNow(),
      },
      captured.output,
    );
    expect(code).toBe(EXIT_CODES.success);
    const text = captured.lines.join("\n");
    expect(text).not.toMatch(/\u001b/);
    expect(text.match(/^status: /gm)).toHaveLength(1);
  });

  it("formatted errors never carry diagnostic details", () => {
    const error = appError("INTERNAL", "boom", { details: { secret: "shh" } });
    expect(formatError(error)).toBe("[INTERNAL] boom");
  });
});

describe("version contract", () => {
  it("single source matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(URBUDDY_VERSION).toBe(pkg.version);
  });
});
