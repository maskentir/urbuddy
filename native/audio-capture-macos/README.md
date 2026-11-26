# Native macOS audio capture helper

Single-file Swift helper (`capture.swift`) that acquires system
audio through Apple's Core Audio Tap APIs and streams framed PCM
to stdout.

Build (macOS only):

```sh
pnpm native:build
```

The binary lands in `bin/` (gitignored, never committed) and is
resolved by the TypeScript integration relative to the package root,
with an explicit `URBUDDY_AUDIO_HELPER` absolute-path override.

Protocol: stdout carries little-endian binary frames
(`magic u32 0x55424431`, `kind u16`, `version u16`, `seq u16`,
`payload u32 length`, payload). Kinds: `0` format
(`sampleRate u32`, `channels u16`, `encoding u16`), `1` audio
(`startFrame u64` in per-channel frames, interleaved float32 PCM),
`2` end (`captured/delivered/dropped u64`, `reason u16`,
`sourceFrames u64`). Diagnostics and counters go to stderr as JSON
lines; no audio content is ever written to logs or disk.

Capture positions use the source clock: every captured callback
advances it, including chunks lost to ring overflow, so downstream
gap accounting sees the true timeline. The ring (`--ring-slots`,
default 64) drops whole chunks with a counter instead of
truncating; the TypeScript side pauses stdout past 4 MiB and reports
drops as explicit gaps. The real-time callback allocates nothing,
logs nothing, and never blocks; teardown checks every OSStatus.

The helper ships without an embedded `Info.plist` and must stay
anonymous: a bundle identifier on ad-hoc signing makes the system
refuse capture startup. Local capture was verified with real
controlled playback and needs no signing, plist, or prompt on the
qualified machine; production distribution signing is a separate,
unqualified concern.

`--synthetic-frames N` generates a deterministic 440 Hz sine through
the same framing and handoff path for transport tests. It never
touches Core Audio and must not be mistaken for real capture.
