# Speech evaluation corpus (local layout)

This directory holds local evaluation layout only. Audio bytes, derived
clips, and evaluation outputs are never committed.

## Layout

- `corpus/` — local audio items and their metadata sidecars (gitignored).
  Each item uses provider-independent naming
  (`<category>-<nnn>.wav` plus a `<name>.json` sidecar recording original
  filename, source provider, category, format, SHA-256, redistribution
  status, and reference-transcript status).
- `results/` — local measurement outputs (gitignored).

## Current local item

| Corpus ID                        | Source                             | Format                         | Reference transcript       |
| -------------------------------- | ---------------------------------- | ------------------------------ | -------------------------- |
| `multi-speaker-conversation-001` | Meta Muse provider demo (owner DL) | 24 kHz mono PCM16 WAV, 186.3 s | unavailable (not verified) |

The provider demo is not an independent benchmark and its demo transcript
is not ground truth. WER or diarization quality is reported only against
an independently reviewed reference, which does not yet exist.

## Rules

- Verify SHA-256 before and after any relocation; refuse to overwrite a
  different destination file.
- Do not commit WAV bytes, derived clips, LFS pointers, credentials, or
  private audio. Ignore rules are narrow (`corpus/`, `results/`), not a
  global audio ignore.
- Sending any item to a live provider requires explicit owner
  authorization; deterministic local tests use a local WebSocket server.
