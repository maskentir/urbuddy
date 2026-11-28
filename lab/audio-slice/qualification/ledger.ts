import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AttemptRecord {
  readonly at: string;
  readonly authorization: string;
  readonly transmittedSeconds: number;
  readonly estimatedCostUsd: number;
  readonly fixtureSha256: string;
  readonly trace: string;
}

export interface LedgerState {
  readonly attempts: readonly AttemptRecord[];
}

export interface LedgerLimits {
  readonly maxAttempts: number;
  readonly maxCumulativeSeconds: number;
  readonly maxCumulativeCostUsd: number;
}

export interface LedgerDecision {
  readonly allowed: boolean;
  readonly detail: string;
}

export const QUALIFICATION_LEDGER_LIMITS: LedgerLimits = {
  maxAttempts: 3,
  maxCumulativeSeconds: 90,
  maxCumulativeCostUsd: 0.01,
};

export function emptyLedger(): LedgerState {
  return { attempts: [] };
}

export function readLedger(path: string): LedgerState {
  if (!existsSync(path)) return emptyLedger();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { attempts?: AttemptRecord[] };
    return { attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [] };
  } catch {
    return emptyLedger();
  }
}

export function writeLedger(path: string, state: LedgerState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { flag: "w" });
  void dirname(path);
}

export function cumulativeUsage(state: LedgerState): {
  readonly attempts: number;
  readonly seconds: number;
  readonly costUsd: number;
} {
  return {
    attempts: state.attempts.length,
    seconds: state.attempts.reduce((total, attempt) => total + attempt.transmittedSeconds, 0),
    costUsd: state.attempts.reduce((total, attempt) => total + attempt.estimatedCostUsd, 0),
  };
}

export function ledgerDecision(
  state: LedgerState,
  limits: LedgerLimits,
  nextAttemptSeconds: number,
  nextAttemptCostUsd: number,
): LedgerDecision {
  const usage = cumulativeUsage(state);
  const detail =
    `attempts ${usage.attempts}/${limits.maxAttempts}, ` +
    `audio ${usage.seconds.toFixed(2)}/${limits.maxCumulativeSeconds}s, ` +
    `cost USD ${usage.costUsd.toFixed(6)}/${limits.maxCumulativeCostUsd.toFixed(4)}; ` +
    `this attempt adds ${nextAttemptSeconds.toFixed(2)}s and USD ${nextAttemptCostUsd.toFixed(6)}`;
  if (usage.attempts + 1 > limits.maxAttempts) {
    return { allowed: false, detail: `${detail}; attempt ceiling reached` };
  }
  if (usage.seconds + nextAttemptSeconds > limits.maxCumulativeSeconds) {
    return { allowed: false, detail: `${detail}; cumulative audio ceiling reached` };
  }
  if (usage.costUsd + nextAttemptCostUsd > limits.maxCumulativeCostUsd) {
    return { allowed: false, detail: `${detail}; cumulative cost ceiling reached` };
  }
  return { allowed: true, detail };
}

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
