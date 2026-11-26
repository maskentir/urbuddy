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
        URBUDDY_PROFILE: "development",
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
    expect(result.value.profile).toBe("development");
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

  it("profile ceilings agree across config validation and effective grants", () => {
    const rows: ReadonlyArray<{
      readonly profile: "offline" | "evaluation" | "simulation" | "development" | "personal";
      readonly egress: boolean;
      readonly child: boolean;
      readonly configOk: boolean;
      readonly effectiveEgress: boolean;
      readonly effectiveChild: boolean;
    }> = [
      {
        profile: "offline",
        egress: false,
        child: false,
        configOk: true,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "offline",
        egress: true,
        child: false,
        configOk: false,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "offline",
        egress: false,
        child: true,
        configOk: false,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "offline",
        egress: true,
        child: true,
        configOk: false,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "evaluation",
        egress: false,
        child: false,
        configOk: true,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "evaluation",
        egress: true,
        child: false,
        configOk: false,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "evaluation",
        egress: false,
        child: true,
        configOk: false,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "evaluation",
        egress: true,
        child: true,
        configOk: false,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "simulation",
        egress: false,
        child: false,
        configOk: true,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "simulation",
        egress: true,
        child: false,
        configOk: false,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "simulation",
        egress: false,
        child: true,
        configOk: true,
        effectiveEgress: false,
        effectiveChild: true,
      },
      {
        profile: "simulation",
        egress: true,
        child: true,
        configOk: false,
        effectiveEgress: false,
        effectiveChild: true,
      },
      {
        profile: "development",
        egress: false,
        child: false,
        configOk: true,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "development",
        egress: true,
        child: false,
        configOk: true,
        effectiveEgress: true,
        effectiveChild: false,
      },
      {
        profile: "development",
        egress: false,
        child: true,
        configOk: true,
        effectiveEgress: false,
        effectiveChild: true,
      },
      {
        profile: "development",
        egress: true,
        child: true,
        configOk: true,
        effectiveEgress: true,
        effectiveChild: true,
      },
      {
        profile: "personal",
        egress: false,
        child: false,
        configOk: true,
        effectiveEgress: false,
        effectiveChild: false,
      },
      {
        profile: "personal",
        egress: true,
        child: false,
        configOk: true,
        effectiveEgress: true,
        effectiveChild: false,
      },
      {
        profile: "personal",
        egress: false,
        child: true,
        configOk: true,
        effectiveEgress: false,
        effectiveChild: true,
      },
      {
        profile: "personal",
        egress: true,
        child: true,
        configOk: true,
        effectiveEgress: true,
        effectiveChild: true,
      },
    ];
    for (const row of rows) {
      const loaded = loadSessionConfig({
        env: {},
        flags: {
          profile: row.profile,
          allowNetworkEgress: row.egress,
          allowChildProcesses: row.child,
        },
      });
      expect(loaded.isOk(), `${row.profile} egress=${row.egress} child=${row.child}`).toBe(
        row.configOk,
      );
      const effective = effectivePolicy(
        { allowNetworkEgress: row.egress, allowChildProcesses: row.child },
        row.profile,
        "/data",
      );
      expect(isPermitted(effective, "network-egress")).toBe(row.effectiveEgress);
      expect(isPermitted(effective, "spawn-child-process")).toBe(row.effectiveChild);
    }
  });

  it("flags always win over env (seeded property)", () => {
    fc.assert(
      fc.property(
        fc.record({
          profile: fc.constantFrom("development", "personal"),
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
