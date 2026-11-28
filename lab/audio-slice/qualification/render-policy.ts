export type RenderTrigger = "partial" | "final" | "discontinuity" | "progress" | "clock";

export interface RenderDecision {
  readonly render: boolean;
  readonly reason: string;
}

export const CLOCK_RENDER_INTERVAL_MS = 1_000;

export interface RenderPolicyOptions {
  /** [tooling] Only used to compare the previous policy with the current one. */
  readonly renderProgress?: boolean;
}

/**
 * [correctness] A provider progress event carries no visible state, so it
 * must not cause a content render, while a partial, a final, or a
 * discontinuity must render at once.
 */
export function decideRender(
  trigger: RenderTrigger,
  sinceLastRenderMs: number,
  options: RenderPolicyOptions = {},
): RenderDecision {
  if (trigger === "progress") {
    return options.renderProgress === true
      ? { render: true, reason: "progress renders only for the before and after comparison" }
      : { render: false, reason: "progress carries no visible state" };
  }
  if (trigger === "clock") {
    return {
      render: sinceLastRenderMs >= CLOCK_RENDER_INTERVAL_MS,
      reason: `clock renders at most every ${CLOCK_RENDER_INTERVAL_MS}ms`,
    };
  }
  return { render: true, reason: `${trigger} changes the visible state` };
}
