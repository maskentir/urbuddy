# Adaptive Single Flow (bounded lab experiment)

Isolated design experiment comparing a single-flow interaction model against
the founder walkthrough (`walkthrough/`, untracked) and the frozen convergence
prototype (`d0e97e1`, untouched). Same synthetic rebuild-window event sequence
in all three surfaces for a controlled comparison.

Live surface: `C` recover context · `R` prepare a response · `Esc` return to
live. Transport keys (`Space`/`.`) exist only with `--replay` and are hidden
otherwise. Meeting closure owns review/vocabulary; they stay out of the live
surface.

```sh
./node_modules/.bin/tsx --tsconfig lab/adaptive-single-flow/tsconfig.json lab/adaptive-single-flow/run.tsx --help
./node_modules/.bin/tsx --tsconfig lab/adaptive-single-flow/tsconfig.json lab/adaptive-single-flow/run.tsx
./node_modules/.bin/vitest run --config lab/adaptive-single-flow/vitest.config.ts
FORCE_COLOR=3 ./node_modules/.bin/tsx --tsconfig lab/adaptive-single-flow/tsconfig.json lab/adaptive-single-flow/capture.tsx
```

Offline, no network, no credentials, no persistence. No human data. Statuses:
human usability NOT-RUN, production design HOLD.
