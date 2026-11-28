export interface QualificationTimeouts {
  readonly maxTransmittedAudioSeconds: number;
  readonly connectionSeconds: number;
  readonly finalizationSeconds: number;
  readonly watchdogSeconds: number;
}

export interface TimeoutInput {
  readonly maxTransmittedAudioSeconds: number;
  readonly connectionSeconds: number;
  readonly finalizationSeconds: number;
  readonly fixtureDurationSeconds: number;
}

/**
 * [correctness] The transmitted audio ceiling, the connection allowance, the
 * finalization allowance, and the session watchdog are separate limits, and
 * the operation limit is the watchdog, so a paced source is never cut off by
 * the audio budget alone.
 */
export function qualificationTimeouts(input: TimeoutInput): QualificationTimeouts {
  const watchdogSeconds =
    input.maxTransmittedAudioSeconds + input.connectionSeconds + input.finalizationSeconds;
  return {
    maxTransmittedAudioSeconds: input.maxTransmittedAudioSeconds,
    connectionSeconds: input.connectionSeconds,
    finalizationSeconds: input.finalizationSeconds,
    watchdogSeconds,
  };
}

export function timeoutDecision(
  timeouts: QualificationTimeouts,
  fixtureDurationSeconds: number,
): { readonly fits: boolean; readonly detail: string } {
  const fits = fixtureDurationSeconds <= timeouts.maxTransmittedAudioSeconds;
  const detail =
    `fixture ${fixtureDurationSeconds.toFixed(2)}s against a transmitted ceiling of ` +
    `${timeouts.maxTransmittedAudioSeconds}s, connection ${timeouts.connectionSeconds}s, ` +
    `finalization ${timeouts.finalizationSeconds}s, watchdog ${timeouts.watchdogSeconds}s`;
  return { fits, detail };
}
