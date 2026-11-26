import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { systemClock, type Clock } from "@kernel/clock";
import { runWithCorrelationId } from "@kernel/correlation";
import { formatError, toAppError, type AppError } from "@kernel/errors";
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
import { effectivePolicy, isPermitted, type SecurityPolicy } from "@modules/security/policy";
import { SessionRuntime } from "@modules/session/runtime";
import { openLineSource } from "@platform/fixture";
import { createLogger, type Logger } from "@platform/logging";
import { resolveAppPaths, type AppPaths } from "@platform/paths";
import { exitCodeForError, extractGlobalFlags, runCli, type CliDeps } from "@presentation/cli";
import { createReplayPort } from "@presentation/replay";

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
    replayPort: createReplayPort({
      runtime: new SessionRuntime(),
      openSource: (fixture, sourceSignal) => openLineSource(fixture, { signal: sourceSignal }),
      ...(isPermitted(app.policy, "load-native-module")
        ? {
            openStore: async () => {
              const { EvidenceStore } = await import("@platform/persistence/store");
              return EvidenceStore.open(join(app.paths.data, "evidence.sqlite"));
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
