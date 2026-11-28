import {
  MUSE_MODEL_ID,
  MUSE_TRANSCRIBE_ENDPOINT_ENV,
  resolveMuseEndpoint,
} from "../../../src/adapters/speech/muse.js";

export const FIXTURE_PROVENANCE =
  "Authored for Urbuddy. Spoken locally by macOS system voices. " +
  "No personal, private, confidential, or third-party meeting content.";

function officialEndpoint(): string {
  const resolved = resolveMuseEndpoint(undefined);
  return resolved.isOk() ? resolved.value : "wss://api.meta.ai/v1/asr/realtime";
}

export const MUSE_OFFICIAL_ENDPOINT = officialEndpoint();

export type PreflightStatus = "pass" | "fail" | "unverified";

export interface PreflightCheck {
  readonly id: string;
  readonly status: PreflightStatus;
  readonly detail: string;
}

export interface PreflightInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly providerId: string;
  readonly modelId: string;
  readonly ownerAuthorized: boolean;
  readonly authorizationReference: string | undefined;
  readonly maxAudioSeconds: number;
  readonly maxAttempts: number;
  readonly maxBillableSeconds: number;
  readonly spendingCeilingUsd: number;
  readonly fixtureDurationMs: number;
  readonly fixtureSampleRate: number;
  readonly fixtureChannels: number;
  readonly fixtureProvenance: string;
  readonly loopbackEndpoint?: string;
  readonly cumulativeBudget?: { readonly allowed: boolean; readonly detail: string };
  readonly watchdogConnectionSeconds: number;
  readonly watchdogFinalizationSeconds: number;
}

export interface PreflightResult {
  readonly checks: readonly PreflightCheck[];
  readonly blocked: boolean;
}

const MAX_AUDIO_SECONDS = 30;
const MAX_ATTEMPTS = 3;
const MAX_BILLABLE_SECONDS = 90;
const MAX_SPENDING_CEILING_USD = 0.01;
export const PROVIDER_HANDSHAKE_TIMEOUT_SECONDS = 10;
export const PROVIDER_DRAIN_TIMEOUT_SECONDS = 15;
const EXPECTED_MAX_COST_USD = 0.0045;

export function expectedMaxCostUsd(maxAttempts: number): number {
  return (maxAttempts * MAX_AUDIO_SECONDS * 0.18) / 3600;
}

export function runPreflight(input: PreflightInput): PreflightResult {
  const checks: PreflightCheck[] = [];
  const add = (id: string, status: PreflightStatus, detail: string): void => {
    checks.push({ id, status, detail });
  };

  const credential = input.env["URBUDDY_META_API_KEY"];
  const loopback = input.loopbackEndpoint !== undefined;
  add(
    "credential-availability",
    credential !== undefined && credential.trim().length > 0 ? "pass" : loopback ? "pass" : "fail",
    credential !== undefined && credential.trim().length > 0
      ? "URBUDDY_META_API_KEY is available (value not displayed)"
      : loopback
        ? "loopback smoke: the adapter uses its own test credential"
        : "URBUDDY_META_API_KEY is not configured",
  );

  add(
    "explicit-provider-selection",
    input.providerId === "muse" ? "pass" : "fail",
    `provider=${input.providerId} (no fallback is permitted)`,
  );

  add(
    "explicit-model-selection",
    input.modelId === MUSE_MODEL_ID ? "pass" : "fail",
    input.modelId === MUSE_MODEL_ID
      ? `model=${input.modelId} is the supported Muse model`
      : `model=${input.modelId} is not the supported Muse model ${MUSE_MODEL_ID}`,
  );

  const endpointOverride = input.env[MUSE_TRANSCRIBE_ENDPOINT_ENV];
  const endpoint =
    input.loopbackEndpoint ??
    (endpointOverride === undefined ? MUSE_OFFICIAL_ENDPOINT : endpointOverride);
  add(
    "official-endpoint",
    endpoint === MUSE_OFFICIAL_ENDPOINT
      ? "pass"
      : loopback && endpoint.startsWith("ws://127.0.0.1")
        ? "pass"
        : "fail",
    endpoint === MUSE_OFFICIAL_ENDPOINT
      ? `endpoint=${endpoint}`
      : loopback
        ? `loopback smoke endpoint=${endpoint} (no paid request, no egress)`
        : `endpoint override detected (${endpoint}); a paid run must use the official endpoint`,
  );

  add(
    "streaming-format",
    input.fixtureSampleRate === 16_000 && input.fixtureChannels === 1 ? "pass" : "fail",
    `fixture=${input.fixtureSampleRate}Hz ${input.fixtureChannels}ch -> PCM_16KHZ (no upsampling)`,
  );

  add(
    "account-access",
    "unverified",
    "account access and geographic eligibility can only be confirmed by an authorized request",
  );
  add(
    "data-processing-retention",
    "unverified",
    "zero data retention is documented at price parity; the scope was not contractually verified",
  );
  add(
    "content-provenance",
    input.fixtureProvenance.trim().length > 0 ? "pass" : "fail",
    input.fixtureProvenance,
  );

  const durationSeconds = input.fixtureDurationMs / 1000;
  add(
    "audio-duration",
    durationSeconds > 0 && durationSeconds <= MAX_AUDIO_SECONDS ? "pass" : "fail",
    `fixture duration ${durationSeconds.toFixed(2)}s (budget ${MAX_AUDIO_SECONDS}s per attempt)`,
  );
  add(
    "request-limits",
    input.maxAudioSeconds <= MAX_AUDIO_SECONDS &&
      input.maxAttempts <= MAX_ATTEMPTS &&
      input.maxBillableSeconds <= MAX_BILLABLE_SECONDS
      ? "pass"
      : "fail",
    `per attempt ${input.maxAudioSeconds}s, attempts ${input.maxAttempts}, billable ${input.maxBillableSeconds}s ` +
      `(ceilings ${MAX_AUDIO_SECONDS}s/${MAX_ATTEMPTS}/${MAX_BILLABLE_SECONDS}s)`,
  );
  add(
    "budget-guard",
    input.spendingCeilingUsd <= MAX_SPENDING_CEILING_USD ? "pass" : "fail",
    `owner ceiling USD ${input.spendingCeilingUsd.toFixed(4)} ` +
      `(max USD ${MAX_SPENDING_CEILING_USD.toFixed(2)}), expected maximum USD ${EXPECTED_MAX_COST_USD.toFixed(4)}`,
  );
  add(
    "contributor-mode",
    endpoint === MUSE_OFFICIAL_ENDPOINT || loopback ? "pass" : "fail",
    "the documented production transcription model on the official endpoint is used",
  );
  add(
    "owner-authorization",
    input.ownerAuthorized || loopback ? "pass" : "fail",
    input.ownerAuthorized
      ? `authorized by ${input.authorizationReference ?? "the invoking owner"}`
      : loopback
        ? "loopback smoke: no paid request and no external transmission"
        : "no explicit owner authorization for paid execution and external audio transmission",
  );

  add(
    "provider-timeout-boundaries",
    input.watchdogConnectionSeconds >= PROVIDER_HANDSHAKE_TIMEOUT_SECONDS &&
      input.watchdogFinalizationSeconds >= PROVIDER_DRAIN_TIMEOUT_SECONDS
      ? "pass"
      : "fail",
    `the provider handshake times out after ${PROVIDER_HANDSHAKE_TIMEOUT_SECONDS}s and the ` +
      `finalization drain after ${PROVIDER_DRAIN_TIMEOUT_SECONDS}s; the watchdog allowances are ` +
      `${input.watchdogConnectionSeconds}s and ${input.watchdogFinalizationSeconds}s`,
  );
  if (input.cumulativeBudget !== undefined) {
    add(
      "cumulative-budget",
      input.cumulativeBudget.allowed ? "pass" : "fail",
      input.cumulativeBudget.detail,
    );
  }
  const blocked = checks.some((check) => check.status === "fail");
  return { checks, blocked };
}

export function formatPreflight(result: PreflightResult): string {
  const lines = result.checks.map((check) => {
    const mark =
      check.status === "pass" ? "ok" : check.status === "fail" ? "BLOCKED" : "unverified";
    return `  [${mark.padEnd(10)}] ${check.id}: ${check.detail}`;
  });
  lines.push(result.blocked ? "preflight: BLOCKED" : "preflight: ready");
  return lines.join("\n");
}
