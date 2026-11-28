# Muse STT qualification run — 2026-11-28

Status: executed. One owner-authorized paid attempt against the official
Meta endpoint with non-private synthetic audio.

## Authorization

| Item                       | Value                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Owner authorization        | `owner-approval-2026-11-28-attempt-1` (1 attempt)                                                                       |
| Attempts authorized / used | 1 / 1                                                                                                                   |
| Endpoint                   | `wss://api.meta.ai/v1/asr/realtime`                                                                                     |
| Model                      | `muse-voice-transcribe-1.0`                                                                                             |
| Mode                       | `endpointing`                                                                                                           |
| Audio                      | `lab/audio-slice/qualification/audio/qualification.wav`, locally generated, 29.53 s, 16 kHz mono PCM16                  |
| Content                    | authored for Urbuddy, spoken by macOS system voices, no personal, private, confidential, or third-party meeting content |

## Provider session

| Observation            | Value                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Provider session id    | `urbuddy-mx054ine-0`                                                                |
| Connection established | 1395 ms after the source format was known (`connectionEpoch epoch=0 uncertainMs=0`) |
| Provider events        | 437: 1 epoch, 5 `turnStarted`, 62 partial, 5 `turnEnded`, 5 completed, 359 progress |
| Canonical events       | 62 partial, 5 final, 359 progress, 1 discontinuity                                  |
| Runtime result         | 5 utterances, 0 duplicates, 0 stale, 0 rejections                                   |
| Shutdown               | exit 0, provider end acknowledged, session terminated                               |

## Audio sent and cost

| Item                       | Value                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| Audio transmitted          | 239 frames, 917,760 bytes, 28.68 s at PCM_16KHZ                     |
| Locally estimated charge   | USD 0.001434 at USD 0.18 per audio hour billed per processed second |
| Owner ceiling              | USD 0.01 for the qualification; this attempt used 14.3 % of it      |
| Provider-confirmed billing | NOT VERIFIED. The provider issued no invoice in this run.           |
| Unrelated paid calls       | none. Translation is not constructed for a qualification run.       |

The last 0.85 s of the fixture was not delivered: the operation duration
limit of 30 s expired while the paced source was still sending, and the
production validator reported the tail gap explicitly rather than
padding it.

## Transcript

Reference:

> The export finished, but replication lag is still above two minutes.
> Can we bump the connection pool limit before the next batch? Sure, but
> the pool saturates when the vacuum and the reindex overlap. Actually,
> correction. Saturation starts earlier; the write ahead log backs up
> first. Then the compaction lease is held by the stale replica, so the
> tombstone sweep waits. Understood. I will cap the vacuum window and
> watch p99 latency.

Finalized by the provider:

> The export finished but replication lag is still above two minutes Can
> we bump the connection pool limit before the next batch? Sure, but the
> pool saturates when the vacuum and the reindex overlap. Actually,
> correction, saturation starts earlier the right ahead log backs up
> first. Then the compaction leases held by the stale replica so the
> tombstone sweep waits. Understood, I will cap the vacuum window and
> watch page 99

## Quality

| Measure                    | Value                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Word error rate            | 11.11 % (7 substitutions, 8 deletions, 7 insertions over 72 reference words)                         |
| Normalization              | lowercase, punctuation removed, hyphens split, whitespace collapsed; no number or spelling expansion |
| Technical-term accuracy    | 75.0 % (6 of 8)                                                                                      |
| Reference turns            | 6                                                                                                    |
| Finalized utterances       | 5, because the provider merged the third and fourth reference turns into one final                   |
| Duplicated finals          | 0                                                                                                    |
| Discontinuities            | 1, the capture tail gap                                                                              |
| Partial-to-final stability | 62 partials across 5 turns; every final replaced the last partial of its turn                        |

Technical terms recognized: replication lag, connection pool, vacuum,
reindex, compaction lease, tombstone sweep.

### Material meaning changes

1. `write ahead log` became `the right ahead log`. The component name
   changed, so a reader would look for a different thing.
2. `p99 latency` became `page 99`. The metric identity was lost and a
   number that is not in the source was introduced.
3. Punctuation was dropped throughout. This is not a meaning change and
   was not counted as one.

A 30 second sample cannot establish a provider accuracy rate. The sample
size, the single voice, and the endpointing mode are stated so that no
accuracy claim is made from it.

## Latency

Monotonic clock, five samples. Percentiles are not reported because the
sample count is too small.

| Measure                           | n   | min  | p50   | max   | observations (ms)               |
| --------------------------------- | --- | ---- | ----- | ----- | ------------------------------- |
| First partial after speech onset  | 5   | 2118 | 2394  | 8486  | 2118, 2273, 2394, 8139, 8486    |
| End of speech to final            | 5   | 1677 | 5845  | 8159  | 1677, 1688, 5845, 7253, 8159    |
| Provider event to observed render | 5   | 0    | 0     | 1     | 0, 0, 0, 0, 1                   |
| Total source to observed render   | 5   | 5066 | 11009 | 13054 | 5066, 5959, 11009, 12256, 13054 |

Two of the five first-partial samples are inflated because the provider
merged two reference turns, so the ordinal pairing of provider turns to
reference segments is approximate after that merge. The content-level
word error rate is not affected by the pairing.

### Engineering targets

| Target                                         | Result                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| First partial within 1 s of speech onset       | Not met. Fastest observation 2118 ms, including the 1395 ms connection setup. |
| Final transcript within 1.5 s of speech end    | Not met. Fastest observation 1677 ms.                                         |
| Provider event to observed render below 100 ms | Met. Five observations, maximum 1 ms.                                         |

These are qualification targets, not prevalidated provider guarantees.

## Resource and failure behaviour

| Measure                        | Value                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Process CPU                    | user 3353 ms, system 257 ms over 30.4 s wall                                            |
| Resident memory                | 155.4 MiB at shutdown                                                                   |
| Queue depth                    | the provider adapter keeps a bounded queue of 1024 events and a bounded outbound buffer |
| Busy-wait                      | none. Quiescence is an explicit completion event, not a poll.                           |
| Credential exposure            | none in the trace, the frames, or the summary                                           |
| Hidden capture                 | none. The only source is the local WAV file.                                            |
| Stale and duplicate protection | intact; 0 stale, 0 duplicates in the run                                                |
| Orphaned processes             | none. The provider session terminated and the transport closed.                         |

The renderer re-rendered on every provider progress event, 427 renders in
30 seconds. Progress carries no content, so those renders are avoidable
work. This is an efficiency finding, not a correctness finding.

## Remaining findings

1. The provider merged two reference turns into one final. Addressee and
   turn-level assistance would be wrong on merged turns.
2. Two technical terms were misrecognized in ways that change meaning.
3. The first partial is far slower than the proposed one second target.
4. The 30 second operation limit truncated the fixture tail. A
   qualification run needs a duration limit that accounts for the
   connection setup.
5. Progress events trigger renders.
6. Speaker diarization and addressee recognition are not qualified by this
   endpointing run.

---

## Correction, 2026-11-28 (appended, the results above are preserved)

An independent review found two defects in the evaluator that produced the
word error rate above. The original results are preserved above. This
section records the corrected evaluation of the same raw trace and the
code changes that made it correct.

### Reviewer findings and their resolution

| Finding                                                                                       | Resolution                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Substitutions were also pushed into the deletion and insertion arrays                         | `lab/audio-slice/qualification/word-alignment.ts` counts a substitution once, as its own operation, and keeps the pair                                                         |
| `normalizeWords` kept sentence-ending periods although the policy says punctuation is removed | The policy is now explicit as `norm-v2` and strips sentence punctuation from token edges while preserving intra-token technical and numeric punctuation                        |
| The evaluator paired reference segments and provider turns by array index                     | The mapping now comes from a transcript alignment that supports one segment to many turns, many segments to one turn, missing segments, inserted turns, and ambiguous mappings |

### Corrected evaluation of the same trace

| Measure         | Original | Corrected   |
| --------------- | -------- | ----------- |
| Reference words | 72       | 72          |
| Substitutions   | 7        | **4**       |
| Deletions       | 8        | **1**       |
| Insertions      | 7        | **0**       |
| Edit distance   | 22       | **5**       |
| Word error rate | 11.111 % | **6.944 %** |

The corrected counts match the independent review exactly. The
substitution pairs are `write` to `right`, `is` to `leases`, `p99` to
`page`, and `latency` to `99`, with the single deletion `lease`. The
alternative minimal alignment that attributes the same edit to
`lease` to `leases` and deletes `is` is equally valid and yields the same
counts.

Technical-term accuracy is unchanged at 75 % (6 of 8). The two material
meaning changes are unchanged: `write ahead log` became `the right ahead
log`, and `p99 latency` became `page 99`.

### Corrected turn alignment

| Reference segment | Provider turn | Status     |
| ----------------- | ------------- | ---------- |
| t1                | turn 0        | aligned    |
| t2                | turn 1        | aligned    |
| t3                | turn 2        | **merged** |
| t4                | turn 2        | **merged** |
| t5                | turn 3        | aligned    |
| t6                | turn 4        | aligned    |

The ordinal pairing in the original report mislabelled every segment
after the merge. The alignment shows that the provider produced five
finals for six reference turns and that no reference content is missing.

### Metrics that the preserved trace cannot establish

The preserved trace predates the corrected instrumentation, so the
following cannot be recovered and are not manufactured:

- The first partial latency after the transmitted onset. The trace has no
  source sample position per transmitted frame.
- The end of speech to final latency measured from the transmitted audio.
- The provider event to observed render latency. The trace recorded a
  render request immediately after the rerender call, with no completion
  boundary and no utterance identity.
- The cold start split. The trace has no session initiation row.
- The complete audio transmission gate. The trace has no source frame
  count to compare against the transmitted frame count.

The one metric the preserved trace does establish is the count of
provider events and the number of renders under the previous policy: 427
canonical events produced 427 render observations.

### Provenance

| Item                 | Value                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Executed revision    | `7281f89325d2a2240ec573e0bfb3b1e69068d5b5`                                                                   |
| Evaluator revision   | the commit that adds `word-alignment.ts` and the alignment based mapping                                     |
| Normalization policy | `norm-v2`                                                                                                    |
| Raw trace            | `muse-1795854066445.jsonl`, sha256 `d9d913b0666831c40b553fc25bc9618365cb43e4b91aca8a5cdc2bbb9557b4b2`        |
| Fixture              | `qualification.wav`, sha256 `02531e349be6bd360c3dbb58d862d1c87b59d9b4830fc2f65f8b25f8bee7ecfc`               |
| Reference transcript | `reference.json`, sha256 `a37df87f19fd1d35c22106ac968f40f43c12f49caed0ec54b4808de781c0e6b1`                  |
| Captured sequence    | `fixtures/captured-sequence.json`, sha256 `72b9f011a642fa36e7c274b32110b7b42e83feaf60a8bc474e4ab7d6a46d17cf` |

The raw trace stays private and is not committed.
