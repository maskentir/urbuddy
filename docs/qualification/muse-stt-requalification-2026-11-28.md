# Muse STT requalification run — 2026-11-28

Status: executed. One owner-authorized bounded attempt against the official
Meta endpoint with non-private synthetic audio. Vocabulary biasing was
enabled intentionally. This run qualifies the configured product path.

## Authorization and cumulative accounting

| Item                        | Value                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner authorization         | `owner-approval-2026-11-28-attempt-2`, one additional request                                                                                                                                           |
| Attempt                     | 2 of 3 permitted by the qualification ceiling                                                                                                                                                           |
| Cumulative audio            | 28.68 s + 29.533 s = 58.213 s of the 90 s billable ceiling                                                                                                                                              |
| Cumulative estimated charge | USD 0.001434 + USD 0.001477 = USD 0.002911 of the USD 0.01 ceiling                                                                                                                                      |
| Retention uncertainty       | Zero data retention is documented at price parity. The scope of that claim was not contractually verified, so the audio may fall under whatever retention the vendor applies. Disclosed before the run. |
| Automatic retry             | None. A failed run would have stopped.                                                                                                                                                                  |

The command was:

```sh
pnpm lab:muse-qualification --env-file .env --owner-authorized --authorization owner-approval-2026-11-28-attempt-2
```

## Provenance

| Item                 | Value                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Executed HEAD        | `328433c37eb5d57f1debf7bf733d5789ead0535f`                                                                     |
| Fixture              | `qualification.wav`, sha256 `02531e349be6bd360c3dbb58d862d1c87b59d9b4830fc2f65f8b25f8bee7ecfc`, unchanged      |
| Reference transcript | `reference.json`, sha256 `a37df87f19fd1d35c22106ac968f40f43c12f49caed0ec54b4808de781c0e6b1`, unchanged         |
| Raw trace            | `muse-1795858982446.jsonl`, sha256 `2e35a4020e0ec82c0191825876fd9d485ae07619e148ae88628285d715f09116`, private |
| Normalization policy | `norm-v2`                                                                                                      |
| Provider             | Muse, `muse-voice-transcribe-1.0`, endpointing                                                                 |
| Provider session     | `urbuddy-mx081uvc-0`                                                                                           |
| Vocabulary           | `storage-observability-domain-v1`, 16 domain terms, sent in the handshake                                      |

## A. Integration integrity

| Gate                            | Measured result                                                      |
| ------------------------------- | -------------------------------------------------------------------- |
| Source samples                  | 472,528 frames at 16 kHz mono                                        |
| Transmitted frames              | 472,528 frames, 945,056 bytes, 29.533 s                              |
| Pairing mismatch                | 0                                                                    |
| Provider connection             | acknowledged, `connectionEpoch epoch=0 uncertainMs=0`                |
| Provider end acknowledgement    | yes, provider summary with 4 finals, 65 partials, 0 discontinuities  |
| Unexpected discontinuities      | 0                                                                    |
| Stale canonical state           | 0                                                                    |
| Duplicate canonical state       | 0                                                                    |
| Rejected events                 | 0                                                                    |
| Turn alignment                  | valid, 4 provider turns mapped to 6 reference segments with 2 merges |
| Reference injected into runtime | no                                                                   |
| Transcript correction applied   | no                                                                   |
| Clean shutdown                  | yes, exit 0                                                          |

## Canonical transcript

Provider finalization, four turns:

1. `The export finished but replication lag is still above two minutes.`
2. `Can we bump the connection pool limit before the next batch?`
3. `Sure, but the pool saturates when the vacuum and the reindex overlap. Actually, correction, saturation starts earlier. The write ahead log backs up first.`
4. `Then the compaction lease is held by the stale replica. So the tombstone sweep waits. Understood. I will cap the vacuum window and watch page 99 latency.`

Rendered output from the same run:

```text
00:07 · Can we bump the connection pool limit before the next batch?
00:12 · Sure, but the pool saturates when the vacuum and the reindex overlap. Actually,
       correction, saturation starts earlier. The write ahead log backs up first.
00:21 · Then the compaction lease is held by the stale replica. So the tombstone sweep waits.
       Understood. I will cap the vacuum window and watch page 99 latency.
```

Translation and intelligence assistance are disabled for a qualification
run and the surface says so.

## B. Provider quality

| Measure                    | Value                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Word error rate            | 2.778 % (1 substitution, 0 deletions, 1 insertion, edit distance 2 over 72 reference words)           |
| Technical-term accuracy    | 87.5 % (7 of 8)                                                                                       |
| Material semantic errors   | one. `p99 latency` became `page 99 latency`, so the metric identity was still lost.                   |
| Recognized technical terms | replication lag, connection pool, vacuum, reindex, write ahead log, compaction lease, tombstone sweep |
| Merged turns               | the provider merged reference segments t3 and t4 into one turn, and t5 and t6 into one turn           |
| Turn alignment             | valid: 4 provider turns, 2 merges, 0 missing, 0 inserted, 0 ambiguous                                 |

The previous attempt scored 6.944 % with 75 % technical-term accuracy and
lost `write ahead log` to `the right ahead log` and `p99 latency` to
`page 99`. This run kept `write ahead log` and still lost `p99` to
`page`. The difference between the two runs is not attributable to
vocabulary biasing alone, because the transmission truncation and the
measurement defects were corrected at the same time. A single 30 second
sample does not establish a provider accuracy rate.

## C. Provider latency

All values are measured on one monotonic clock. Sample counts are small,
so individual observations are reported instead of percentiles.

| Measure                                             | n   | min    | p50    | max    | observations (ms)            |
| --------------------------------------------------- | --- | ------ | ------ | ------ | ---------------------------- |
| Cold start, session initiation to first partial     | 1   | 3028.6 | 3028.6 | 3028.6 | 3028.6                       |
| Streaming first partial after the transmitted onset | 4   | 789.7  | 914.0  | 1531.6 | 789.7, 914.0, 1031.0, 1531.6 |
| End of transmitted speech to final                  | 4   | 306.4  | 382.7  | 515.3  | 306.4, 309.6, 455.9, 515.3   |
| Provider event to confirmed render                  | 0   | n/a    | n/a    | n/a    | unavailable                  |
| Total transmitted source to confirmed render        | 0   | n/a    | n/a    | n/a    | unavailable                  |

The provider event to confirmed render measurement is unavailable for this
run. The confirmation mechanism read the terminal output buffer that was
shared between overlapping flush callbacks, so no render could be proven to
have carried a particular transcript revision. The defect is corrected
after this run, and the correction is covered by a regression test. The
measurement is not manufactured from the trace.

### Performance targets

| Target                                         | Result                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| First partial within 1 s of speech onset       | Met in 3 of 4 observations, p50 914 ms, worst 1531.6 ms. Not met for every turn.                                                 |
| Final within 1.5 s of speech end               | Met. Worst observation 515.3 ms.                                                                                                 |
| Provider event to observed render below 100 ms | Unavailable, the confirmation defect above. The first attempt measured 0 to 1 ms with the previous, less strict instrumentation. |

## Resource and failure behavior

| Measure                                | Value                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| Process CPU                            | user 1276 ms, system 127 ms over a 32 s run                                             |
| Resident memory                        | 139.1 MiB at shutdown                                                                   |
| Provider events                        | 370 progress, 65 partial, 8 other                                                       |
| Render requests and completions        | 100 and 100                                                                             |
| Canonical applications and projections | 69 and 69                                                                               |
| Queue depth                            | the provider adapter keeps a bounded queue of 1024 events and a bounded outbound buffer |
| Busy-wait                              | none, quiescence is an explicit completion event                                        |
| Cancellation                           | the abort signal owns the source iteration, the provider session, and the transport     |
| Cleanup                                | the provider session terminated and the transport closed, no orphaned process           |
| Credential exposure                    | none in the trace, the frames, or the summary                                           |

The previous attempt used user 3353 ms and system 257 ms with 427 render
observations. The current run used user 1276 ms and system 127 ms with 100
render requests, because progress events no longer trigger a content
render.

## Cumulative usage

| Item                       | Value                                                      |
| -------------------------- | ---------------------------------------------------------- |
| Attempts                   | 2 of 3                                                     |
| Audio transmitted          | 58.213 s of 90 s                                           |
| Estimated charge           | USD 0.002911 of USD 0.01                                   |
| Provider-confirmed billing | not verified, the provider issued no invoice in either run |

## Known limitation of this run

The provider event to confirmed render latency could not be established.
Everything else in the mandatory evidence list was measured.
