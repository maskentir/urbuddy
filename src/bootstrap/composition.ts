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
import { ResourceScope, type ManagedResource } from "@kernel/lifecycle";
import {
  loadSessionConfig,
  type ConfigFlags,
  type ImmutableSessionConfig,
} from "@modules/config/loader";
import { effectivePolicy, type SecurityPolicy } from "@modules/security/policy";
import { createLogger, type Logger } from "@platform/logging";
import { resolveAppPaths, type AppPaths } from "@platform/paths";
import { exitCodeForError, extractGlobalFlags, runCli, type CliDeps } from "@presentation/cli";

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

function cliDepsFrom(app: AppContainer): CliDeps {
  return {
    version: URBUDDY_VERSION,
    config: app.config,
    paths: app.paths,
    sessionId: app.sessionId,
    correlationId: app.correlationId,
    nowIso: app.clock.isoNow(),
  };
}

export function startApp(app: AppContainer): void {
  app.logger.info("app started", { profile: app.config.profile, version: URBUDDY_VERSION });
}

export interface StopAppOptions {
  readonly exitCode: ExitCode;
  readonly signal?: AbortSignal;
}

export async function stopApp(
  app: AppContainer,
  options: StopAppOptions,
): Promise<{ error?: AppError }> {
  const disposed = await app.scope.disposeAll(options.signal);
  if (disposed.isErr()) {
    return { error: disposed.error };
  }
  return {};
}

export function trackResource(app: AppContainer, resource: ManagedResource): boolean {
  const result = app.scope.register(resource);
  if (result.isErr()) {
    app.logger.error(formatError(result.error));
    return false;
  }
  return true;
}

export async function runApp(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<ExitCode> {
  const shutdown = new AbortController();
  const onSignal = (): void => {
    shutdown.abort();
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
        code = await runCli(argv, cliDepsFrom(app));
      } catch (thrown: unknown) {
        const error = toAppError(thrown, "unhandled CLI failure");
        app.logger.error(formatError(error));
        code = exitCodeForError(error);
      }
      if (shutdown.signal.aborted && code === EXIT_CODES.success) {
        code = EXIT_CODES.cancelled;
      }
      const stopped = await stopApp(app, { exitCode: code, signal: shutdown.signal });
      if (stopped.error !== undefined) {
        app.logger.error(formatError(stopped.error));
        if (code === EXIT_CODES.success) {
          code = EXIT_CODES.generalError;
        }
      }
      return code;
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
