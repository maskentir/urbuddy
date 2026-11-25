# Security policy

## Posture

Default-deny. Capabilities (`network-egress`, `spawn-child-process`,
`load-native-module`, `write-outside-data-root`) are denied unless
explicitly granted through the session config, and profiles cap what the
config may grant (`src/modules/security/policy.ts`).

Currently, `load-native-module` and `write-outside-data-root` are denied
unconditionally: there are no native sidecars yet, and writes belong
under the resolved data root.

## Reporting

This is a local skeleton with no release line yet. If you find a
vulnerability in the skeleton itself (e.g. a guard that fails open),
open an issue with the failing case as a test. Do not publish exploits
against other people's deployments.

## Non-goals

No network services listen. `doctor` performs read-only local
checks. Nothing is uploaded anywhere: there is no telemetry, no paid
API usage, and no remote publish path to audit.
