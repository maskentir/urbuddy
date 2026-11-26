import manifest from "../../package.json" with { type: "json" };

const declared: unknown = (manifest as { readonly version?: unknown }).version;
if (typeof declared !== "string" || !/^\d+\.\d+\.\d+$/.test(declared)) {
  throw new Error("urbuddy requires a semver package.json version");
}

export const URBUDDY_VERSION: string = declared;
