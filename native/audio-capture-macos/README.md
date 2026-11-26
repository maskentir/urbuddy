# Native macOS audio capture helper

Single-file Swift helper (`capture.swift`) that acquires system audio
through Apple's Core Audio Tap APIs and streams framed PCM to stdout.

Build (macOS only):

```sh
pnpm native:build
```

The binary lands in `bin/` (gitignored, never committed) and is
resolved by the TypeScript integration relative to the package root,
with an explicit `URBUDDY_AUDIO_HELPER` absolute-path override.

Protocol: stdout carries little-endian binary frames
(`magic u32 0x55424431`, `kind u16`, `version u16`, `seq u64`,
`payload u32 length`, payload). Kinds: `0` format
(`sampleRate u32`, `channels u16`, `encoding u16`), `1` audio
(`startSample u64`, interleaved float32 PCM), `2` end
(`captured u64`, `delivered u64`, `dropped u64`, `reason u16`).
Diagnostics and counters go to stderr as JSON lines; no audio content
is ever written to logs or disk.

The helper ships without an embedded `Info.plist`. A bundle
identifier on an ad-hoc-signed helper causes the system to refuse
capture startup, while an anonymous helper starts and receives
silence until the user grants consent. Production distribution needs
Developer ID signing with `NSAudioCaptureUsageDescription` and a
user-approved consent prompt in a GUI session.

`--synthetic-frames N` generates a deterministic 440 Hz sine through
the same framing path for transport tests. It never touches Core
Audio and must not be mistaken for real capture.
