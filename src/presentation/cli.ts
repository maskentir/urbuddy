import { commandHelp } from "@kernel/commands";
import { appError, toAppError, type AppError, type ErrorCode } from "@kernel/errors";
import { EXIT_CODES, type ExitCode } from "@kernel/exit-codes";
import type { CorrelationId, SessionId } from "@kernel/ids";
import type { ConfigFlags, ImmutableSessionConfig } from "@modules/config/loader";
import { stripFormatting, toStableJson } from "@platform/output";
import type { AppPaths } from "@platform/paths";
import { Command, CommanderError } from "commander";
import { match } from "ts-pattern";

import type { CaptureInput, CapturePort } from "./capture.js";
import { runInkSmoke } from "./ink-smoke.js";
import { createStreamOutput } from "./output.js";
import type { CliOutput } from "./output.js";
import type { ReplayPort } from "./replay.js";
import type { TranscribeInput, TranscribePort } from "./transcribe.js";

export interface CliDeps {
  readonly version: string;
  readonly config: ImmutableSessionConfig;
  readonly paths: AppPaths;
  readonly sessionId: SessionId;
  readonly correlationId: CorrelationId;
  readonly nowIso: string;
  readonly signal: AbortSignal;
  readonly replayPort?: ReplayPort;
  readonly capturePort?: CapturePort;
  readonly transcribePort?: TranscribePort;
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
  readonly envFile?: string;
  readonly profile?: string;
  readonly logLevel?: string;
  readonly dataRoot?: string;
  readonly allowEgress?: boolean;
  readonly allowChild?: boolean;
  readonly allowNative?: boolean;
}

function addGlobalOptions(program: Command): Command {
  return program
    .option("--env-file <path>", "load capability settings and credentials from an explicit file")
    .option(
      "--profile <name>",
      "session profile (development|simulation|evaluation|personal|offline)",
    )
    .option("--log-level <level>", "log level (trace|debug|info|warn|error|fatal)")
    .option("--data-root <dir>", "override the session data directory")
    .option("--allow-egress", "grant network egress for this session")
    .option("--allow-child", "grant child-process spawning for this session")
    .option("--allow-native", "grant native module loading for this session");
}

function toConfigFlags(values: GlobalOptionValues): ConfigFlags {
  return {
    ...(values.profile === undefined ? {} : { profile: values.profile }),
    ...(values.logLevel === undefined ? {} : { logLevel: values.logLevel }),
    ...(values.dataRoot === undefined ? {} : { dataRoot: values.dataRoot }),
    ...(values.allowEgress === undefined ? {} : { allowNetworkEgress: values.allowEgress }),
    ...(values.allowChild === undefined ? {} : { allowChildProcesses: values.allowChild }),
    ...(values.allowNative === undefined ? {} : { allowNativeModules: values.allowNative }),
  };
}

export function extractGlobalFlags(
  argv: readonly string[],
): ConfigFlags & { readonly envFile?: string } {
  const probe = addGlobalOptions(new Command());
  probe.parseOptions([...argv]);
  const values = probe.opts<GlobalOptionValues>();
  return {
    ...toConfigFlags(values),
    ...(values.envFile === undefined ? {} : { envFile: values.envFile }),
  };
}

export function createProgram(deps: CliDeps, providedOutput?: CliOutput): Command {
  const output = providedOutput ?? createStreamOutput(process.stdout, process.stderr, deps.signal);
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
    .action(async () => {
      await output.out(`urbuddy ${deps.version}`);
    });

  program
    .command("doctor")
    .description(commandHelp("doctor"))
    .option("--json", "emit the report as stable JSON", false)
    .action(async (options: { json: boolean }) => {
      const report = buildDoctorReport(deps);
      if (options.json) {
        await output.out(toStableJson(report));
      } else {
        await output.out(formatDoctorText(report));
      }
      if (!report.ok) {
        throw new Error("doctor checks failing");
      }
    });

  program
    .command("capture")
    .description(commandHelp("capture"))
    .option("--duration <seconds>", "capture duration in seconds (1 to 300)", "10")
    .option(
      "--synthetic-frames <count>",
      "use synthetic transport-test frames instead of system audio",
      "0",
    )
    .option("--json", "emit one stable JSON object per line", false)
    .action(async (options: { duration: string; syntheticFrames: string; json: boolean }) => {
      if (deps.capturePort === undefined) {
        throw new Error("capture is not wired");
      }
      if (!/^\d+$/.test(options.duration)) {
        throw appError("VALIDATION_FAILED", "capture duration must be 1 to 300 seconds");
      }
      const durationSeconds = Number.parseInt(options.duration, 10);
      if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) {
        throw appError("VALIDATION_FAILED", "capture duration must be 1 to 300 seconds");
      }
      if (!/^\d+$/.test(options.syntheticFrames)) {
        throw appError("VALIDATION_FAILED", "synthetic frame count must be 0 to 100000");
      }
      const syntheticFrames = Number.parseInt(options.syntheticFrames, 10);
      if (
        !Number.isSafeInteger(syntheticFrames) ||
        syntheticFrames < 0 ||
        syntheticFrames > 100_000
      ) {
        throw appError("VALIDATION_FAILED", "synthetic frame count must be 0 to 100000");
      }
      const captureInput: CaptureInput = {
        durationMs: durationSeconds * 1000,
        syntheticFrames,
        json: options.json,
        signal: deps.signal,
        output,
      };
      const result = await deps.capturePort(captureInput);
      if (result.isErr()) {
        throw result.error;
      }
    });

  program
    .command("transcribe")
    .description(commandHelp("transcribe"))
    .option("--provider <name>", "speech provider (muse)")
    .option("--stt-model <id>", "supported speech model")
    .option("--file <wav>", "transcribe a local WAV file paced as a live stream")
    .option("--duration <seconds>", "live capture duration in seconds (1 to 300)", "30")
    .option("--mode <mode>", "recognition mode (endpointing or diarization)", "endpointing")
    .option("--keywords <terms>", "comma-separated vocabulary biasing terms")
    .option("--json", "emit one stable JSON object per line", false)
    .option("--translate", "send transcript text for translation (requires --allow-egress)", false)
    .option("--source-language <tag>", "translation source language tag or auto")
    .option("--target-language <tag>", "translation target language tag")
    .option("--translation-provider <name>", "translation provider")
    .option("--translation-model <id>", "compatible translation model")
    .action(
      async (options: {
        provider?: string;
        sttModel?: string;
        file?: string;
        duration: string;
        mode: string;
        keywords?: string;
        json: boolean;
        translate: boolean;
        sourceLanguage?: string;
        targetLanguage?: string;
        translationProvider?: string;
        translationModel?: string;
      }) => {
        if (deps.transcribePort === undefined) {
          throw new Error("transcribe is not wired");
        }
        if (options.mode !== "endpointing" && options.mode !== "diarization") {
          throw appError("VALIDATION_FAILED", "transcribe mode must be endpointing or diarization");
        }
        if (!/^\d+$/.test(options.duration)) {
          throw appError("VALIDATION_FAILED", "transcribe duration must be 1 to 300 seconds");
        }
        const durationSeconds = Number.parseInt(options.duration, 10);
        if (
          !Number.isSafeInteger(durationSeconds) ||
          durationSeconds < 1 ||
          durationSeconds > 300
        ) {
          throw appError("VALIDATION_FAILED", "transcribe duration must be 1 to 300 seconds");
        }
        const keywords =
          options.keywords === undefined
            ? []
            : options.keywords
                .split(",")
                .map((term) => term.trim())
                .filter((term) => term.length > 0);
        if (keywords.length > 100 || keywords.some((term) => term.length > 64)) {
          throw appError("VALIDATION_FAILED", "vocabulary terms exceed the supported bound");
        }
        const transcribeInput: TranscribeInput = {
          ...(options.file === undefined ? {} : { file: options.file }),
          durationMs: durationSeconds * 1000,
          mode: options.mode,
          keywords,
          json: options.json,
          translate: options.translate,
          ...(options.provider === undefined ? {} : { sttProvider: options.provider }),
          ...(options.sttModel === undefined ? {} : { sttModel: options.sttModel }),
          translationFlags: {
            ...(options.sourceLanguage === undefined
              ? {}
              : { sourceLanguage: options.sourceLanguage }),
            ...(options.targetLanguage === undefined
              ? {}
              : { targetLanguage: options.targetLanguage }),
            ...(options.translationProvider === undefined
              ? {}
              : { translationProvider: options.translationProvider }),
            ...(options.translationModel === undefined
              ? {}
              : { translationModel: options.translationModel }),
          },
          signal: deps.signal,
          output,
        };
        const result = await deps.transcribePort(transcribeInput);
        if (result.isErr()) {
          throw result.error;
        }
      },
    );

  program
    .command("replay")
    .description(commandHelp("replay"))
    .argument("<fixture>", "path to a synthetic NDJSON transcript fixture")
    .option("--json", "emit one stable JSON object per line", false)
    .option("--persist", "persist replay evidence (requires native module authorization)", false)
    .option("--operation-id <id>", "stable operation identity for an idempotent persistent replay")
    .action(
      async (
        fixture: string,
        options: { json: boolean; persist: boolean; operationId?: string },
      ) => {
        if (deps.replayPort === undefined) {
          throw new Error("replay is not wired");
        }
        const result = await deps.replayPort({
          fixture,
          json: options.json,
          signal: deps.signal,
          output,
          persist: options.persist,
          ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
        });
        if (result.isErr()) {
          throw result.error;
        }
      },
    );

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
        await output.out(stripFormatting(`ink smoke ok (session ${deps.sessionId})`));
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
