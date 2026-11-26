import {
  PROFILE_CAPABILITIES,
  type Profile,
  type ProfileCapabilities,
} from "@modules/config/loader";

export interface SecurityPolicy {
  readonly allowNetworkEgress: boolean;
  readonly allowChildProcesses: boolean;
  readonly allowNativeModules: boolean;
  readonly dataRoot: string;
}

export type SensitiveAction =
  "network-egress" | "spawn-child-process" | "load-native-module" | "write-outside-data-root";

export function defaultDenyPolicy(dataRoot: string): SecurityPolicy {
  return {
    allowNetworkEgress: false,
    allowChildProcesses: false,
    allowNativeModules: false,
    dataRoot,
  };
}

export function effectivePolicy(
  grants: ProfileCapabilities,
  profile: Profile,
  dataRoot: string,
): SecurityPolicy {
  const ceiling = PROFILE_CAPABILITIES[profile];
  return {
    allowNetworkEgress: grants.allowNetworkEgress && ceiling.allowNetworkEgress,
    allowChildProcesses: grants.allowChildProcesses && ceiling.allowChildProcesses,
    allowNativeModules: grants.allowNativeModules && ceiling.allowNativeModules,
    dataRoot,
  };
}

export function isPermitted(policy: SecurityPolicy, action: SensitiveAction): boolean {
  switch (action) {
    case "network-egress":
      return policy.allowNetworkEgress;
    case "spawn-child-process":
      return policy.allowChildProcesses;
    case "load-native-module":
      return policy.allowNativeModules;
    case "write-outside-data-root":
      return false;
  }
}
