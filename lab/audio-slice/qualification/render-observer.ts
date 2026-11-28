export interface RenderTarget {
  readonly utteranceId: string;
  readonly revision: number;
  readonly text: string;
}

export interface RenderObservation {
  readonly kind: "render-requested" | "render-completed";
  readonly utteranceId: string;
  readonly revision: number;
  readonly confirmed?: boolean;
  readonly monoMs: number;
}

export type RenderEmitter = (observation: RenderObservation) => void;

function comparable(text: string): string {
  return text
    .replace(/\u001B\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * [correctness] A render request is recorded separately from a render
 * completion, and a completion is only confirmed when the written output
 * holds the text of the utterance and revision that was requested.
 */
export function createRenderObserver(
  emit: RenderEmitter,
  now: () => number,
): {
  request: (target: RenderTarget) => void;
  complete: (target: RenderTarget, written: string) => void;
} {
  return {
    request: (target: RenderTarget): void => {
      emit({
        kind: "render-requested",
        utteranceId: target.utteranceId,
        revision: target.revision,
        monoMs: now(),
      });
    },
    complete: (target: RenderTarget, written: string): void => {
      emit({
        kind: "render-completed",
        utteranceId: target.utteranceId,
        revision: target.revision,
        confirmed: target.text.length > 0 && comparable(written).includes(comparable(target.text)),
        monoMs: now(),
      });
    },
  };
}
