export interface Clock {
  now(): number;
  isoNow(): string;
}

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    isoNow: () => new Date().toISOString(),
  };
}

export interface FixedClock extends Clock {
  advance(ms: number): void;
}

export function fixedClock(startMs: number): FixedClock {
  let current = startMs;
  return {
    now: () => current,
    isoNow: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
  };
}
