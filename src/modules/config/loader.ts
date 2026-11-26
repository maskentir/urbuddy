import { appError, type AppError } from "@kernel/errors";
import { logLevelSchema } from "@kernel/log-level";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export const PROFILES = ["development", "simulation", "evaluation", "personal", "offline"] as const;
export type Profile = (typeof PROFILES)[number];

export interface ProfileCapabilities {
  readonly allowNetworkEgress: boolean;
  readonly allowChildProcesses: boolean;
}

export const PROFILE_CAPABILITIES: Readonly<Record<Profile, ProfileCapabilities>> = {
  offline: { allowNetworkEgress: false, allowChildProcesses: false },
  evaluation: { allowNetworkEgress: false, allowChildProcesses: false },
  simulation: { allowNetworkEgress: false, allowChildProcesses: true },
  development: { allowNetworkEgress: true, allowChildProcesses: true },
  personal: { allowNetworkEgress: true, allowChildProcesses: true },
};

const sessionConfigSchema = z.object({
  profile: z.enum(PROFILES),
  appName: z.string().min(1),
  dataRootOverride: z.string().min(1).optional(),
  logLevel: logLevelSchema,
  allowNetworkEgress: z.boolean(),
  allowChildProcesses: z.boolean(),
});

export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type ImmutableSessionConfig = Readonly<SessionConfig>;

const DEFAULTS: SessionConfig = {
  profile: "development",
  appName: "urbuddy",
  logLevel: "info",
  allowNetworkEgress: false,
  allowChildProcesses: false,
};

export interface ConfigFlags {
  readonly profile?: string;
  readonly logLevel?: string;
  readonly dataRoot?: string;
  readonly allowNetworkEgress?: boolean;
  readonly allowChildProcesses?: boolean;
}

export interface ConfigInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly flags?: ConfigFlags;
}

function parseEnvBoolean(
  raw: string | undefined,
  name: string,
): Result<boolean | undefined, AppError> {
  if (raw === undefined || raw === "") {
    return ok(undefined);
  }
  if (raw === "1" || raw === "true") {
    return ok(true);
  }
  if (raw === "0" || raw === "false") {
    return ok(false);
  }
  return err(appError("CONFIG_INVALID", `env ${name} must be one of 1/0/true/false`));
}

export function loadSessionConfig(
  input: ConfigInput = {},
): Result<ImmutableSessionConfig, AppError> {
  const env = input.env ?? {};
  const flags = input.flags ?? {};

  const egressEnv = parseEnvBoolean(env["URBUDDY_ALLOW_EGRESS"], "URBUDDY_ALLOW_EGRESS");
  if (egressEnv.isErr()) {
    return err(egressEnv.error);
  }
  const childEnv = parseEnvBoolean(env["URBUDDY_ALLOW_CHILD"], "URBUDDY_ALLOW_CHILD");
  if (childEnv.isErr()) {
    return err(childEnv.error);
  }

  const draft: {
    profile: string;
    appName: string;
    dataRootOverride?: string;
    logLevel: string;
    allowNetworkEgress: boolean;
    allowChildProcesses: boolean;
  } = {
    profile: DEFAULTS.profile,
    appName: DEFAULTS.appName,
    logLevel: DEFAULTS.logLevel,
    allowNetworkEgress: DEFAULTS.allowNetworkEgress,
    allowChildProcesses: DEFAULTS.allowChildProcesses,
  };

  const envProfile = env["URBUDDY_PROFILE"];
  if (envProfile !== undefined && envProfile !== "") {
    draft.profile = envProfile;
  }
  const envLevel = env["URBUDDY_LOG_LEVEL"];
  if (envLevel !== undefined && envLevel !== "") {
    draft.logLevel = envLevel;
  }
  const envRoot = env["URBUDDY_DATA_ROOT"];
  if (envRoot !== undefined && envRoot !== "") {
    draft.dataRootOverride = envRoot;
  }
  if (egressEnv.value !== undefined) {
    draft.allowNetworkEgress = egressEnv.value;
  }
  if (childEnv.value !== undefined) {
    draft.allowChildProcesses = childEnv.value;
  }

  if (flags.profile !== undefined) {
    draft.profile = flags.profile;
  }
  if (flags.logLevel !== undefined) {
    draft.logLevel = flags.logLevel;
  }
  if (flags.dataRoot !== undefined) {
    draft.dataRootOverride = flags.dataRoot;
  }
  if (flags.allowNetworkEgress !== undefined) {
    draft.allowNetworkEgress = flags.allowNetworkEgress;
  }
  if (flags.allowChildProcesses !== undefined) {
    draft.allowChildProcesses = flags.allowChildProcesses;
  }

  const parsed = sessionConfigSchema.safeParse(draft);
  if (!parsed.success) {
    return err(
      appError("CONFIG_INVALID", "session config failed validation", {
        details: { issues: parsed.error.issues.map((issue) => issue.message).join("; ") },
      }),
    );
  }

  const guard = applyProfileGuards(parsed.data);
  if (guard.isErr()) {
    return err(guard.error);
  }
  return ok(Object.freeze(guard.value));
}

function applyProfileGuards(config: SessionConfig): Result<SessionConfig, AppError> {
  const ceiling = PROFILE_CAPABILITIES[config.profile];
  if (config.allowNetworkEgress && !ceiling.allowNetworkEgress) {
    return err(
      appError("CONFIG_INVALID", `profile '${config.profile}' cannot grant network egress`),
    );
  }
  if (config.allowChildProcesses && !ceiling.allowChildProcesses) {
    return err(
      appError("CONFIG_INVALID", `profile '${config.profile}' cannot grant child processes`),
    );
  }
  return ok(config);
}
