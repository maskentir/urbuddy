# ADR-007: Live Language Engine translation slice

Status: accepted (implementation in `feat/live-language-engine`).

## Context

Speech Perception delivers English transcript events with revision
semantics. The Live Language Engine must turn them into readable
Indonesian while speech is still in flight, without stalling
recognition, duplicating provider work, or silently authorizing a new
cloud destination.

## Decision

- Model gateway: LangChain.js (`@langchain/core@1.5.1`,
  `@langchain/openai@1.8.5`, both MIT, Node >=20/>=22), consumed only
  through a thin OpenAI chat-completions adapter.
- Model: `gpt-6-luna` (verified 2026-11-27 against official OpenAI docs:
  callable ID, Chat Completions + structured-output support, $0.10/$0.50
  per 1M input/output tokens). One configured model, no registry or
  fallback in this slice.
- Raw `model.invoke` with an explicit JSON-schema `response_format`
  plus manual `JSON.parse` + Zod validation, instead of
  `withStructuredOutput`. Measured cause: the structured wrapper hangs
  until the invoke timeout on unparsable model output instead of
  raising a parse error (single stub hit, ~timeout delay, no parse
  exception). Manual parsing fails closed immediately as
  `VALIDATION_FAILED`. Covered by a focused stub regression.
- No automatic retries anywhere in the translation path. Measured
  cause: LangChain's `AsyncCaller` defaults to 6 retries with backoff
  (the OpenAI SDK client itself is already fixed at 0 retries), which
  turned a failing stub into a multi-second hang. The adapter sets
  `maxRetries: 0`; a 500 produces exactly one request and an immediate
  `INTERNAL` degradation. Covered by a single-hit stub regression.
- Prompt assembly (`buildTranslationPrompt`, glossary, version stamp
  `urbuddy-id-translation-v1`) is domain-owned in
  `src/modules/language/translation.ts`. The adapter only maps
  application-owned `{role, content}` messages onto LangChain messages
  and transports them. This keeps application contracts independent of
  LangChain classes and satisfies the adapters-port-type-only boundary
  (dependency-cruiser refined to admit `language/translation` as a
  type-only port, mirroring the perception ports).
- Translation never fails transcription. The scheduler reports per-unit
  degradation events and a summary (`committed`, `staleRejected`,
  `degraded`, `requests`, token usage where observable, `failed`); the
  port returns the transcription result with the translation summary
  attached.
- Authorization: translation requires explicit `--translate`, effective
  network egress, a separate `OPENAI_API_KEY` (never `MODEL_API_KEY`),
  the pinned `https://api.openai.com/v1` endpoint, and a stderr
  disclosure. Loopback test endpoints use a fixed sentinel credential
  and never read the operator key (same pattern as the speech
  adapter).

## Consequences

- Provisional output is bounded by debounce plus a minimum-word delta;
  committed output is sequential per operation with a bounded backlog
  that degrades explicitly instead of dropping work silently.
- Stale responses (superseded revisions, post-final provisionals,
  duplicate finals) are rejected by identity, never by timing.
- Token usage is captured opportunistically from response metadata;
  cost accounting remains estimate-grade until live qualification.
- No WER/accuracy claim: the synthetic corpus carries human-authored
  references and critical invariants for future live evaluation; the
  deterministic suite covers runtime semantics only.
