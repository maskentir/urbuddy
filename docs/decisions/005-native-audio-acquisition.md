# ADR-005: Native macOS audio acquisition

Date: 2026-11-27. Status: accepted. Supersedes the initial consent
conclusion after executor-side verification with real audio.

## Context

Speech Perception needs system-audio frames with explicit continuity
before any STT integration. The transport (tap → aggregate → IPC →
runtime) must be provable on machines where audio content itself may
be gated by macOS consent.

## Decision

- Swift Core Audio Tap helper, one file, built with `swiftc`
  (`pnpm native:build`). No Swift Package Manager: a manifest and
  package layout buy nothing for a single dependency-free file.
- Framed binary IPC over stdout: `magic u32`, `kind u16`,
  `version u16`, `seq u64`, `payload u32 length`, payload. Kinds:
  format, audio (`startFrame u64` in per-channel frames + interleaved
  float32 LE), end (`captured/delivered/dropped u64`, `reason u16`,
  `sourceFrames u64`). Max payload 1 MiB, allocations bounded before
  reading. Diagnostics on stderr only, content-free.
- Buffer extraction uses the buffer-list base offset against the
  original callback memory. Never copy the list struct and never do
  manual arithmetic from the copy: the first buffer lives inside the
  struct and additional buffers follow it in the original memory.
- Format is reported by the helper, validated by TypeScript
  (float32 LE interleaved, sane rate/channel count); no resampling in
  this slice.
- `startFrame` tracks the source clock and advances on every captured
  callback, including dropped ones. Delivery position never rewrites
  the timeline: overflow appears as an explicit gap downstream.
  Oversized or misaligned callbacks are counted as lost, never
  silently truncated.
- Bounded handoff on both sides: os_unfair_lock-guarded ring (default
  64 slots) with drop counting, 4 MiB TypeScript buffer with stdout
  pause/resume. The real-time callback performs no allocation, no
  logging, and no blocking calls; all shared counters sit behind the
  handoff lock.
- Duration deadline triggers graceful SIGTERM (helper end frame),
  caller abort is cancellation; an independent shutdown bound fails
  closed if the helper ignores SIGTERM. Escalation SIGKILL after 2 s.
  Cleanup success only after process close is observed.
- Acquisition stops the engine before final accounting, then drains
  or explicitly accounts outstanding buffered audio. Teardown checks
  every OSStatus instead of ignoring results.
- The helper ships without an embedded `Info.plist` and without a
  bundle identifier. A bundle identifier on ad-hoc signing makes the
  system refuse capture startup; the anonymous helper is not subject
  to that check.
- No ResourceScope: one child with explicit try/finally ownership is
  sufficient; the consumer gate stays open.
- No new dependencies: `node:child_process` covers the single spawn;
  Execa would add no value here.

## Consent findings (executed)

The initial hypothesis — that real content requires Developer ID
signing plus a GUI consent grant — was wrong on this machine and is
withdrawn.

- Anonymous ad-hoc helper, no `Info.plist`: tap attaches, aggregate
  starts, IOProc fires at device rate with real 4096-byte buffers.
- Controlled playback of a known 440 Hz sine through the system mix
  arrives end to end: DFT magnitude 0.24 at 440 Hz with negligible
  energy elsewhere, crest factor 1.41, matching the source signal.
- The earlier all-zero observations were misread buffer contents
  (see buffer extraction above), not a TCC gate. No `tccd` check is
  performed for the anonymous helper path on this machine.
- Bundle-identified ad-hoc helper (embedded `Info.plist`): the
  system performs a TCC check (`coreaudiod` → `tccd`) and refuses
  aggregate start. Ad-hoc identity cannot receive a grant.
- Consequence: local capture works with no signing, no plist, and no
  prompt on the qualified machine. Developer ID signing is not
  established as a requirement. Production distribution signing and
  behavior on other macOS configurations remain separate,
  unqualified concerns.
- Zero samples are reported as indistinguishable from digital
  silence, never as proof of silence, denial, or consent state.

## Consequences

- `urbuddy capture` proves acquisition plumbing, framing,
  continuity, cancellation, and lifecycle end to end. The 440 Hz
  controlled-playback run is the content reference, not a
  production-audio claim.
- `--synthetic-frames` exercises the same path deterministically for
  tests and CI; it is always labeled and never implies real capture.
- STT integration consumes the delivered stream with gap accounting
  and the summary's `signalPresent` flag.
- Remaining verification on other hardware: consent-prompt
  behavior, device changes, and long-session stability.
