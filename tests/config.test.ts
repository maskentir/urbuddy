import { LOG_LEVELS, type LogLevel } from "@kernel/log-level";
import { loadSessionConfig, PROFILES, type SessionConfig } from "@modules/config/loader";
import { defaultDenyPolicy, effectivePolicy, isPermitted } from "@modules/security/policy";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

describe("config loader", () => {
  it("loads defaults with no input and freezes the result", () => {
    const result = loadSessionConfig({ env: {} });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw new Error("defaults must load");
    }
    const config: SessionConfig = result.value;
    const level: LogLevel = config.logLevel;
    expect(level).toBe("info");
    expect(config).toEqual({
      profile: "development",
      appName: "urbuddy",
      logLevel: "info",
      allowNetworkEgress: false,
      allowChildProcesses: false,
    });
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("applies env under flags (flags > env > defaults)", () => {
    const result = loadSessionConfig({
      env: {
        URBUDDY_PROFILE: "simulation",
        URBUDDY_LOG_LEVEL: "debug",
        URBUDDY_DATA_ROOT: "/env-data",
        URBUDDY_ALLOW_EGRESS: "1",
        URBUDDY_ALLOW_CHILD: "true",
      },
      flags: { logLevel: "warn" },
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw new Error("env config must load");
    }
    expect(result.value.profile).toBe("simulation");
    expect(result.value.logLevel).toBe("warn");
    expect(result.value.dataRootOverride).toBe("/env-data");
    expect(result.value.allowNetworkEgress).toBe(true);
    expect(result.value.allowChildProcesses).toBe(true);
  });

  it("rejects invalid input instead of guessing", () => {
    expect(loadSessionConfig({ env: { URBUDDY_PROFILE: "nope" } }).isErr()).toBe(true);
    expect(loadSessionConfig({ env: { URBUDDY_ALLOW_EGRESS: "maybe" } }).isErr()).toBe(true);
    expect(loadSessionConfig({ flags: { logLevel: "verbose" } }).isErr()).toBe(true);
  });

  it("profiles never bypass permissions", () => {
    const offline = loadSessionConfig({
      env: {},
      flags: { profile: "offline", allowNetworkEgress: true },
    });
    expect(offline.isErr()).toBe(true);
    const evaluation = loadSessionConfig({
      env: {},
      flags: { profile: "evaluation", allowNetworkEgress: true },
    });
    expect(evaluation.isErr()).toBe(true);
    const offlineClean = loadSessionConfig({ env: {}, flags: { profile: "offline" } });
    expect(offlineClean.isOk()).toBe(true);
  });

  it("flags always win over env (seeded property)", () => {
    fc.assert(
      fc.property(
        fc.record({
          profile: fc.constantFrom("development", "simulation", "personal"),
          logLevel: fc.constantFrom(...LOG_LEVELS),
          egress: fc.boolean(),
          child: fc.boolean(),
          root: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
        }),
        (wanted) => {
          const result = loadSessionConfig({
            env: {
              URBUDDY_PROFILE: "offline",
              URBUDDY_LOG_LEVEL: "error",
              URBUDDY_DATA_ROOT: "/env-data",
              URBUDDY_ALLOW_EGRESS: "0",
              URBUDDY_ALLOW_CHILD: "0",
            },
            flags: {
              profile: wanted.profile,
              logLevel: wanted.logLevel,
              dataRoot: wanted.root,
              allowNetworkEgress: wanted.egress,
              allowChildProcesses: wanted.child,
            },
          });
          expect(result.isOk()).toBe(true);
          if (result.isErr()) {
            throw new Error("flags must win");
          }
          expect(result.value.profile).toBe(wanted.profile);
          expect(result.value.logLevel).toBe(wanted.logLevel);
          expect(result.value.dataRootOverride).toBe(wanted.root);
          expect(result.value.allowNetworkEgress).toBe(wanted.egress);
          expect(result.value.allowChildProcesses).toBe(wanted.child);
        },
      ),
      { seed: 20261126, numRuns: 25 },
    );
  });

  it("knows every profile", () => {
    expect([...PROFILES]).toEqual([
      "development",
      "simulation",
      "evaluation",
      "personal",
      "offline",
    ]);
  });
});

describe("security policy", () => {
  it("default deny denies everything", () => {
    const policy = defaultDenyPolicy("/data");
    expect(isPermitted(policy, "network-egress")).toBe(false);
    expect(isPermitted(policy, "spawn-child-process")).toBe(false);
    expect(isPermitted(policy, "load-native-module")).toBe(false);
    expect(isPermitted(policy, "write-outside-data-root")).toBe(false);
  });

  it("restricted profiles cap grants; development passes them through", () => {
    const grants = { allowNetworkEgress: true, allowChildProcesses: true };
    const offline = effectivePolicy(grants, "offline", "/data");
    expect(isPermitted(offline, "network-egress")).toBe(false);
    expect(isPermitted(offline, "spawn-child-process")).toBe(false);
    const evaluation = effectivePolicy(grants, "evaluation", "/data");
    expect(isPermitted(evaluation, "network-egress")).toBe(false);
    const development = effectivePolicy(grants, "development", "/data");
    expect(isPermitted(development, "network-egress")).toBe(true);
    expect(isPermitted(development, "spawn-child-process")).toBe(true);
    expect(isPermitted(development, "load-native-module")).toBe(false);
    expect(isPermitted(development, "write-outside-data-root")).toBe(false);
    expect(development.dataRoot).toBe("/data");
  });
});
