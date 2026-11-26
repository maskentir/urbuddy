import { commandHelp } from "@kernel/commands";
import { toAppError, type AppError, type ErrorCode } from "@kernel/errors";
import { EXIT_CODES, type ExitCode } from "@kernel/exit-codes";
import type { CorrelationId, SessionId } from "@kernel/ids";
import type { ConfigFlags, ImmutableSessionConfig } from "@modules/config/loader";
import { stripFormatting, toStableJson } from "@platform/output";
import type { AppPaths } from "@platform/paths";
import { Command, CommanderError } from "commander";
import { match } from "ts-pattern";

import { runInkSmoke } from "./ink-smoke.js";

export interface CliDeps {
  readonly version: string;
  readonly config: ImmutableSessionConfig;
  readonly paths: AppPaths;
  readonly sessionId: SessionId;
  readonly correlationId: CorrelationId;
  readonly nowIso: string;
  readonly signal: AbortSignal;
}

export interface CliOutput {
  out(line: string): void;
  errLine(line: string): void;
}

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly app: string;
  readonly version: string;
  readonly node: string;
  readonly platform: string;
  readonly profile: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly timestamp: string;
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

const MIN_NODE_MAJOR = 24;

export function nodeMajor(version: string): number | undefined {
  const trimmed = version.startsWith("v") ? version.slice(1) : version;
  const major = Number.parseInt(trimmed.split(".")[0] ?? "", 10);
  return Number.isInteger(major) ? major : undefined;
}

export function runDoctorChecks(deps: CliDeps): DoctorCheck[] {
  const major = nodeMajor(process.version);
  const nodeCheck: DoctorCheck = {
    name: "node-runtime",
    ok: major !== undefined && major >= MIN_NODE_MAJOR,
    detail: `${process.version} (requires >=${MIN_NODE_MAJOR})`,
  };
  const paths = [
    deps.paths.data,
    deps.paths.config,
    deps.paths.cache,
    deps.paths.log,
    deps.paths.temp,
  ];
  const pathsCheck: DoctorCheck = {
    name: "app-paths",
    ok: paths.every((path) => path.trim().length > 0),
    detail: `data=${deps.paths.data}`,
  };
  const configCheck: DoctorCheck = {
    name: "session-config",
    ok: deps.config.appName.length > 0,
    detail: `profile=${deps.config.profile} log=${deps.config.logLevel}`,
  };
  return [nodeCheck, pathsCheck, configCheck];
}

export function buildDoctorReport(deps: CliDeps): DoctorReport {
  const checks = runDoctorChecks(deps);
  return {
    app: "urbuddy",
    version: deps.version,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    profile: deps.config.profile,
    sessionId: deps.sessionId,
    correlationId: deps.correlationId,
    timestamp: deps.nowIso,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

function formatDoctorText(report: DoctorReport): string {
  const lines = [
    `urbuddy doctor (profile ${report.profile})`,
    `version: ${report.version}`,
    `node: ${report.node}`,
    `platform: ${report.platform}`,
    `session: ${report.sessionId}`,
    "checks:",
  ];
  for (const check of report.checks) {
    lines.push(`  [${check.ok ? "ok" : "FAIL"}] ${check.name}: ${check.detail}`);
  }
  lines.push(`status: ${report.ok ? "ok" : "failing"}`);
  return lines.map((line) => stripFormatting(line)).join("\n");
}

export function exitCodeForError(error: AppError): ExitCode {
  const name = match<ErrorCode>(error.code)
    .with("CONFIG_INVALID", () => "configError" as const)
    .with("VALIDATION_FAILED", () => "usage" as const)
    .with("RESOURCE_ACQUIRE_FAILED", () => "generalError" as const)
    .with("RESOURCE_RELEASE_FAILED", () => "generalError" as const)
    .with("CANCELLED", () => "cancelled" as const)
    .with("UNSUPPORTED", () => "usage" as const)
    .with("INTERNAL", () => "generalError" as const)
    .exhaustive();
  return EXIT_CODES[name];
}

interface GlobalOptionValues {
  readonly profile?: string;
  readonly logLevel?: string;
  readonly dataRoot?: string;
  readonly allowEgress?: boolean;
  readonly allowChild?: boolean;
}

function addGlobalOptions(program: Command): Command {
  return program
    .option(
      "--profile <name>",
      "session profile (development|simulation|evaluation|personal|offline)",
    )
    .option("--log-level <level>", "log level (trace|debug|info|warn|error|fatal)")
    .option("--data-root <dir>", "override the session data directory")
    .option("--allow-egress", "grant network egress for this session")
    .option("--allow-child", "grant child-process spawning for this session");
}

function toConfigFlags(values: GlobalOptionValues): ConfigFlags {
  return {
    ...(values.profile === undefined ? {} : { profile: values.profile }),
    ...(values.logLevel === undefined ? {} : { logLevel: values.logLevel }),
    ...(values.dataRoot === undefined ? {} : { dataRoot: values.dataRoot }),
    ...(values.allowEgress === undefined ? {} : { allowNetworkEgress: values.allowEgress }),
    ...(values.allowChild === undefined ? {} : { allowChildProcesses: values.allowChild }),
  };
}

export function extractGlobalFlags(argv: readonly string[]): ConfigFlags {
  const probe = addGlobalOptions(new Command());
  probe.parseOptions([...argv]);
  return toConfigFlags(probe.opts<GlobalOptionValues>());
}

function defaultOutput(): CliOutput {
  return {
    out: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
    errLine: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

export function createProgram(deps: CliDeps, output: CliOutput = defaultOutput()): Command {
  const program = new Command();
  addGlobalOptions(program);
  program
    .name("urbuddy")
    .description("urbuddy — reproducible assistant runtime")
    .version(deps.version, "--version", "print the urbuddy build version")
    .option("--ink-smoke", "run the minimal Ink startup/shutdown smoke path and exit")
    .exitOverride()
    .configureOutput({
      writeOut: (text: string) => {
        output.out(text.trimEnd());
      },
      writeErr: (text: string) => {
        output.errLine(text.trimEnd());
      },
    });

  program
    .command("version")
    .description(commandHelp("version"))
    .action(() => {
      output.out(`urbuddy ${deps.version}`);
    });

  program
    .command("doctor")
    .description(commandHelp("doctor"))
    .option("--json", "emit the report as stable JSON", false)
    .action((options: { json: boolean }) => {
      const report = buildDoctorReport(deps);
      if (options.json) {
        output.out(toStableJson(report));
      } else {
        output.out(formatDoctorText(report));
      }
      if (!report.ok) {
        throw new Error("doctor checks failing");
      }
    });

  program
    .option("--ink-dwell-ms <ms>", "smoke frame duration in milliseconds", "50")
    .action(async () => {
      const options = program.opts<{ inkSmoke?: boolean; inkDwellMs?: string }>();
      if (options.inkSmoke === true) {
        const dwellRaw =
          options.inkDwellMs === undefined ? Number.NaN : Number.parseInt(options.inkDwellMs, 10);
        const result = await runInkSmoke({
          version: deps.version,
          sessionId: deps.sessionId,
          ...(Number.isSafeInteger(dwellRaw) && dwellRaw > 0 ? { dwellMs: dwellRaw } : {}),
          signal: deps.signal,
        });
        if (result.isErr()) {
          throw result.error;
        }
        output.out(stripFormatting(`ink smoke ok (session ${deps.sessionId})`));
        return;
      }
      program.help();
    });

  return program;
}

export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
  output?: CliOutput,
): Promise<ExitCode> {
  const program = createProgram(deps, output);
  try {
    await program.parseAsync([...argv]);
    return EXIT_CODES.success;
  } catch (thrown: unknown) {
    if (thrown instanceof CommanderError) {
      return thrown.exitCode === 0 ? EXIT_CODES.success : EXIT_CODES.usage;
    }
    throw toAppError(thrown, "unhandled CLI failure");
  }
}
