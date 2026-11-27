import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { resolveBundledHelperPath, spawnAudioSource } from "@adapters/audio/capture-source";
import { openWavSource } from "@adapters/audio/wav-source";
import {
  createMuseProvider,
  MUSE_TRANSCRIBE_ENDPOINT_ENV,
  resolveMuseEndpoint,
} from "@adapters/speech/muse";
import { systemClock, type Clock } from "@kernel/clock";
import { runWithCorrelationId } from "@kernel/correlation";
import { appError, formatError, toAppError, type AppError } from "@kernel/errors";
import { EXIT_CODES, type ExitCode } from "@kernel/exit-codes";
import {
  createCryptoIdGenerator,
  type CorrelationId,
  type IdGenerator,
  type SessionId,
} from "@kernel/ids";
import { ResourceScope } from "@kernel/lifecycle";
import {
  loadSessionConfig,
  type ConfigFlags,
  type ImmutableSessionConfig,
} from "@modules/config/loader";
import { runCaptureSession } from "@modules/perception/audio";
import { effectivePolicy, isPermitted, type SecurityPolicy } from "@modules/security/policy";
import type { EvidencePersistence } from "@modules/session/persistence";
import { runReplay } from "@modules/session/replay";
import { openLineSource } from "@platform/fixture";
import { createLogger, type Logger } from "@platform/logging";
import { resolveAppPaths, type AppPaths } from "@platform/paths";
import { createCapturePort } from "@presentation/capture";
import { exitCodeForError, extractGlobalFlags, runCli, type CliDeps } from "@presentation/cli";
import { createReplayPort } from "@presentation/replay";
import { createTranscribePort } from "@presentation/transcribe";
import { err, ok, type Result } from "neverthrow";

import { URBUDDY_VERSION } from "./version.js";

export interface AppContainer {
  readonly config: ImmutableSessionConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly paths: AppPaths;
  readonly scope: ResourceScope;
  readonly policy: SecurityPolicy;
  readonly sessionId: SessionId;
  readonly correlationId: CorrelationId;
}

export interface CreateAppInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly flags?: ConfigFlags;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

export function createAppContainer(input: CreateAppInput = {}): AppContainer | { error: AppError } {
  const ids = input.ids ?? createCryptoIdGenerator();
  const clock = input.clock ?? systemClock();
  const sessionId = ids.sessionId();
  const correlationId = ids.correlationId();

  const configResult = loadSessionConfig({
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.flags === undefined ? {} : { flags: input.flags }),
  });
  if (configResult.isErr()) {
    return { error: configResult.error };
  }
  const config = configResult.value;

  const overrides =
    config.dataRootOverride === undefined ? undefined : { dataRoot: config.dataRootOverride };
  const pathsResult = resolveAppPaths(config.appName, overrides);
  if (pathsResult.isErr()) {
    return { error: pathsResult.error };
  }
  const paths = pathsResult.value;

  const policy = effectivePolicy(
    {
      allowNetworkEgress: config.allowNetworkEgress,
      allowChildProcesses: config.allowChildProcesses,
      allowNativeModules: config.allowNativeModules,
    },
    config.profile,
    paths.data,
  );
  const logger = createLogger({
    level: config.logLevel,
    clock,
    context: { sessionId, correlationId },
  });
  return {
    config,
    clock,
    ids,
    logger,
    paths,
    scope: new ResourceScope(),
    policy,
    sessionId,
    correlationId,
  };
}

export function isAppContainer(value: AppContainer | { error: AppError }): value is AppContainer {
  return !("error" in value);
}

const SHUTDOWN_GRACE_MS = 5_000;

function cliDepsFrom(app: AppContainer, signal: AbortSignal): CliDeps {
  return {
    version: URBUDDY_VERSION,
    config: app.config,
    paths: app.paths,
    sessionId: app.sessionId,
    correlationId: app.correlationId,
    nowIso: app.clock.isoNow(),
    signal,
    capturePort: createCapturePort({
      runSession: runCaptureSession,
      clock: app.clock,
      ...(isPermitted(app.policy, "spawn-child-process")
        ? { spawnSource: spawnAudioSource, resolveHelper: resolveBundledHelperPath }
        : {}),
    }),
    transcribePort: createTranscribePort({
      clock: app.clock,
      ...(isPermitted(app.policy, "network-egress")
        ? {
            createProvider: (env: Readonly<Record<string, string | undefined>>) => {
              const apiKey = env["MODEL_API_KEY"];
              if (apiKey === undefined || apiKey.trim().length === 0) {
                return err(
                  appError(
                    "CONFIG_INVALID",
                    "speech provider credential is not configured (set MODEL_API_KEY)",
                  ),
                );
              }
              const endpoint = resolveMuseEndpoint(env[MUSE_TRANSCRIBE_ENDPOINT_ENV]);
              if (endpoint.isErr()) {
                return err(endpoint.error);
              }
              let loopbackEndpoint: string | undefined;
              try {
                loopbackEndpoint =
                  new URL(endpoint.value).host === "api.meta.ai" ? undefined : endpoint.value;
              } catch {
                return err(appError("VALIDATION_FAILED", "speech provider endpoint is invalid"));
              }
              return ok(
                createMuseProvider({
                  apiKey,
                  ...(loopbackEndpoint === undefined
                    ? {}
                    : { testLoopbackEndpoint: loopbackEndpoint }),
                }),
              );
            },
            openWav: async (path: string) => openWavSource(path, { pacing: "realtime" }),
          }
        : {}),
      ...(isPermitted(app.policy, "spawn-child-process")
        ? {
            spawnCapture: () => {
              const helper = resolveBundledHelperPath(process.env);
              if (helper.isErr()) {
                return err(helper.error);
              }
              return spawnAudioSource({ helperPath: helper.value });
            },
          }
        : {}),
    }),
    replayPort: createReplayPort({
      runOperation: runReplay,
      openSource: (fixture, sourceSignal) => openLineSource(fixture, { signal: sourceSignal }),
      ...(isPermitted(app.policy, "load-native-module")
        ? {
            openPersistence: async (): Promise<Result<EvidencePersistence, AppError>> => {
              const { openEvidenceDatabase } = await import("@platform/persistence/database");
              const evidence = await import("@platform/persistence/evidence");
              const opened = openEvidenceDatabase(join(app.paths.data, "evidence.sqlite"));
              if (opened.isErr()) {
                return err(opened.error);
              }
              const handle = opened.value;
              const persistence: EvidencePersistence = {
                admit: async (opId, sourceFingerprint) =>
                  evidence.admitOperation(handle, opId, sourceFingerprint),
                record: async (event, opId) => {
                  const result = evidence.recordEvent(handle, { ...event, opId });
                  return result.isOk() ? ok(undefined) : err(result.error);
                },
                recordGap: async (gap) => evidence.recordGap(handle, gap),
                verify: async (event) => evidence.verifyEvent(handle, event),
                complete: async (completion) => {
                  const result = evidence.completeOperation(handle, completion);
                  return result.isOk() ? ok(undefined) : err(result.error);
                },
                close: async () => handle.close(),
              };
              return ok(persistence);
            },
            openFingerprintedSource: async (fixture, sourceSignal) => {
              const { openFingerprintedFixture } = await import("@platform/fixture");
              return openFingerprintedFixture(fixture, { signal: sourceSignal });
            },
            newOperationId: () => randomUUID(),
          }
        : {}),
    }),
  };
}

export function startApp(app: AppContainer): void {
  app.logger.info("app started", { profile: app.config.profile, version: URBUDDY_VERSION });
}

export async function stopApp(
  app: AppContainer,
  signal?: AbortSignal,
): Promise<{ error?: AppError }> {
  const disposed = await app.scope.disposeAll(signal);
  if (disposed.isErr()) {
    return { error: disposed.error };
  }
  return {};
}

export async function runApp(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<ExitCode> {
  const work = new AbortController();
  const onSignal = (): void => {
    work.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const created = createAppContainer({ env, flags: extractGlobalFlags(argv) });
    if (!isAppContainer(created)) {
      process.stderr.write(`${formatError(created.error)}\n`);
      return EXIT_CODES.configError;
    }
    const app = created;
    return await runWithCorrelationId(app.correlationId, async () => {
      startApp(app);
      let code: ExitCode;
      try {
        code = await runCli(argv, cliDepsFrom(app, work.signal));
      } catch (thrown: unknown) {
        const error = toAppError(thrown, "unhandled CLI failure");
        app.logger.error(formatError(error));
        code = exitCodeForError(error);
      }
      if (work.signal.aborted && code === EXIT_CODES.success) {
        code = EXIT_CODES.cancelled;
      }
      const cleanup = new AbortController();
      const deadline = setTimeout(() => cleanup.abort(), SHUTDOWN_GRACE_MS);
      try {
        const stopped = await stopApp(app, cleanup.signal);
        if (stopped.error !== undefined) {
          app.logger.error(formatError(stopped.error));
          if (code === EXIT_CODES.success) {
            code = EXIT_CODES.generalError;
          }
        }
        return code;
      } finally {
        clearTimeout(deadline);
      }
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
