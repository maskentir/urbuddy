# ADR-007 · Live Language Engine translation slice

Status: implementation review. Live model and multilingual semantic
qualification are pending.

## Decision

Translation is a separate, opt-in operation on immutable transcript revisions.
The CLI resolves translation settings once. Explicit flags override the
process environment, which overrides an explicitly selected environment
file and then built-in defaults. The defaults are `auto` source interpretation, `id` target,
`openai` provider, and `gpt-6-luna` model. Validated canonical locale tags
express intent. Product support and model quality for each language remain
qualification questions. Translation source settings leave Muse recognition
settings untouched. Code-switched spans retain their meaning, and the prompt
asks the model to preserve spans already spoken in the target language.

The composition root selects OpenAI, the only implemented provider. It
rejects unsupported providers and model identifiers, missing credentials,
invalid endpoints and unauthorized egress before acquisition. A failed
enablement rejects the operation. A translation failure during an admitted
operation preserves transcription and produces translation degradation.
The production endpoint is `https://api.openai.com/v1`. OpenAI uses only
`URBUDDY_OPENAI_API_KEY` from the process environment or selected file. Test translation
accepts a numeric IPv4 loopback destination and uses a sentinel credential.
Bilingual loopback requires paired loopback endpoints and the checked
synthetic smoke WAV, whose PCM is snapshotted before egress. Native capture
is excluded. The production and loopback recipients are disclosed separately.

The adapter uses LangChain Chat Completions with a documented compatible
model selection of `gpt-6-luna` or `gpt-6.1-terra`. It requests
`reasoning_effort: none` and JSON object mode, uses
`max_completion_tokens: 1024`, omits sampling parameters, disables
automatic retries, and applies an eight-second SDK transport timeout.
The installed LangChain routes `json_schema` through the SDK parse path,
which throws for truncation before usage reaches the adapter. JSON object
mode preserves the completion envelope for manual strict validation.
Manual validation checks raw completion status, refusal, tools, JSON
shape and text limits. Reported usage is validated independently of
the completion verdict. Provider failures retain safe HTTP status,
classified error category, allowlisted code and validated request ID when
available. The outbound fetch admits one exact endpoint
and rejects redirects. The LangChain invocation installs a disabled
trace context with empty callbacks. Inherited legacy `LANGCHAIN_TRACING`
fails closed because the installed callback manager treats any nonempty
value as enabled.

The scheduler knows only the application-owned `TranslationProvider`
port. It constructs a versioned system prompt and JSON user data with
bounded source text, ordered prior source evidence, languages and
an optional Indonesia-scoped contextual glossary. Speech, glossary
preferences and context are treated as data. Preserve original meaning
and unresolved fragments, including spoken instructions and delimiter-like
text. The prompt version and glossary identity accompany each translation.

## Scheduling and publication

- One finalized utterance is one committed unit. Perception assigns an
  occurrence sequence at turn creation so late finals exclude later speech
  from context. Speaker labels are approximate attribution. Fragment
  evidence is a source-punctuation heuristic and has no grammatical guarantee.
- Revisions coalesce over a 400 ms window starting at the first pending
  revision. Meaningful shorter and same-length text changes are eligible.
  Preview validity follows source revision, discontinuity and operation
  lifetime. The CLI emits invalidation records as space allows. Consumers
  treat a newer source revision, gap, or terminal event as invalidating
  the corresponding preview even if an explicit invalidation could not
  be delivered. A sink checks validity immediately before the write.
  Bytes already handed to a stream cannot be withdrawn.
- Actual provider admission is sequential across committed and provisional
  work. Committed work takes priority and requests cancellation of active
  provisional work. It waits for local settlement before acquiring the
  slot. The latency trade-off awaits measurement.
- The operation admits at most 4,096 occurrence identities, 16 pending
  partials, 16 queued committed items, and one coalescing timer. Source
  text is limited to 4,000 UTF-8 bytes. Recent context retains at most
  five finalized sources and 2,000 UTF-8 bytes. Exhausted identity
  capacity degrades unseen finals without evicting earlier finality.
- One asynchronous translation publication can be active with 32 waiting.
  Source output retains its normal terminal backpressure. Translation
  work stays off the recognition callback's asynchronous path, with one
  outstanding translation write to the shared stream. A failed shared
  sink can affect source output too. The terminal summary reports
  publication failures and uncovered final identities within the
  admitted bound, plus a count beyond identity capacity.
- A gap clears context and abandons previews without synthesizing source
  finality. A valid late final still translates. Across capture gaps
  without aligned source timestamps, coverage is marked uncertain and
  context remains suppressed until an observed reconnect.
- Normal finish stops source admission, invalidates previews, and drains
  eligible committed and publication work for at most 10 seconds including
  a final 250 ms cancellation grace period. Failure or cancellation stops
  admissions and signals active work. An unsettled invocation or output
  is reported explicitly. Local settlement cannot establish remote
  execution or billing outcomes.

Evidence identifies the operation, occurrence, revision, speaker label
where available, context references, language configuration, provider,
model, prompt and glossary. Successful output records translation
source-event arrival, queue delay, full-response latency, and elapsed
time to publication attempt. Terminal evidence reports committed drain,
local invocation starts, valid responses, invocation failures and
cancellations, stale results, published artifacts, final coverage and
reported usage. Missing usage stays unknown. These metrics measure local
translation work. End-to-end audio latency and semantic quality have
separate qualification gates.

## Provider references

- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
- [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
