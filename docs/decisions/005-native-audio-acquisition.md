# ADR-005: Native macOS audio acquisition

Date: 2026-11-27. Status: accepted for the offline/transport scope.

## Context

Speech Perception needs system-audio frames with explicit continuity
before any STT integration. The transport (tap → aggregate → IPC →
runtime) must be provable on machines where audio content itself is
gated by macOS consent.

## Decision

- Swift Core Audio Tap helper, one file, built with `swiftc`
  (`pnpm native:build`). No Swift Package Manager: a manifest and
  package layout buy nothing for a single dependency-free file.
- Framed binary IPC over stdout: `magic u32`, `kind u16`,
  `version u16`, `seq u64`, `payload u32 length`, payload. Kinds:
  format, audio (`startSample u64` + interleaved float32 LE), end
  (captured/delivered/dropped/reason). Max payload 1 MiB, allocations
  bounded before reading. Diagnostics on stderr only, content-free.
- Format is reported by the helper, validated by TypeScript
  (float32 LE interleaved); no resampling in this slice.
- Bounded buffering on both sides: 64-slot helper ring with drop
  counting, 4 MiB TypeScript buffer with stdout pause/resume.
  Overflow is an explicit gap or a terminal error, never silent loss.
- Duration deadline triggers graceful SIGTERM (helper end frame),
  caller abort is cancellation; escalation SIGKILL after 2 s, cleanup
  success only after process close is observed.
- No ResourceScope: one child with explicit try/finally ownership is
  sufficient; the consumer gate stays open for a future slice that
  can justify it.
- No new dependencies: `node:child_process` covers the single spawn;
  Execa would add no value here.
- The helper ships without an embedded `Info.plist`.

## Consent findings (executed)

- Anonymous ad-hoc helper: tap attaches, aggregate starts, IOProc
  fires at device rate, buffers carry no content (single 1-byte
  buffer, null data on the test machine).
- Bundle-identified ad-hoc helper (embedded `Info.plist`): the
  system performs a TCC check (`coreaudiod` → `tccd`) and refuses
  aggregate start. Ad-hoc identity cannot receive a grant.
- Consequence: real content requires Developer ID signing with
  `NSAudioCaptureUsageDescription` plus a user-approved prompt in a
  GUI session. That verification is an explicit follow-up on a
  consent-capable machine, not a claim of this PR.
- Zero samples are reported as indistinguishable from digital
  silence, never as proof of silence or of denial.

## Consequences

- `urbuddy capture` proves acquisition plumbing, framing,
  continuity, cancellation, and lifecycle end to end.
- `--synthetic-frames` exercises the same path deterministically for
  tests and CI; it is always labeled and never implies real capture.
- STT integration must handle content-gated streams using the
  summary's `signalPresent` flag and gap accounting.
