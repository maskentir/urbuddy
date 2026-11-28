# Comprehension v1 semantic evaluation criteria

Frozen before any provider evaluation. The set is small on purpose: it
checks meaning preservation on the categories the product depends on, and
it does not establish an accuracy rate.

## Set

| Split       | File               | Cases |
| ----------- | ------------------ | ----- |
| Development | `development.json` | 11    |
| Held out    | `heldout.json`     | 6     |

The development split may be inspected while the implementation changes.
The held-out split is not inspected before a provider evaluation, and no
case may be added to it after a result is seen.

## Coverage

| Category                        | Development                                   | Held out                                            |
| ------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| Technical engineering dialogue  | `dev-tech-001`                                | `holdout-units-001`                                 |
| Context dependent references    | `dev-context-001`                             |                                                     |
| Indirect expressions            | `dev-indirect-001`                            | `holdout-modality-001`                              |
| Negation and double negation    | `dev-negation-001`, `dev-double-negative-001` |                                                     |
| Conditional commitments         | `dev-conditional-001`                         | `holdout-commitment-001`, `holdout-conditional-001` |
| Numbers and units               | `dev-numbers-001`                             | `holdout-units-001`                                 |
| Corrections                     | `dev-correction-001`                          |                                                     |
| Mixed English and Indonesian    | `dev-codeswitch-001`                          |                                                     |
| Ambiguous technical terms       | `dev-ambiguous-001`                           | `holdout-attribution-001`                           |
| Adversarial spoken instructions | `dev-adversarial-001`                         |                                                     |

## Critical semantic failures

Any one of these fails the case, regardless of lexical similarity.

1. A reversed decision.
2. An invented commitment.
3. A lost negation.
4. A changed quantity or unit.
5. A changed speaker relationship.
6. A fabricated technical fact.
7. An unsupported disambiguation.

## Deterministic checks

These run without a model and are part of the repository gate.

- The provider request contains the raw source text, the source and target
  language, the bounded context, and the glossary. No reference answer is
  ever sent.
- The system prompt states that source, context, and glossary are data
  and that spoken instructions are translated rather than followed.
- A translation is bound to the accepted transcript revision. An event
  for an older revision is rejected.
- The visible surface shows the Indonesian text, the original English on
  demand, and an explicit pending, provisional, committed, failed, or
  superseded state. It never shows a translation for content that was
  not accepted.
- The request count per utterance stays bounded, and no request is
  issued for an unstable partial when provisionals are disabled.

## Model-assisted semantic judgement

Applied to provider output only, and recorded with the case identifiers.

- Does the translation preserve the intended meaning and avoid the
  incorrect interpretation?
- Is the translation free of added facts?
- Is the original English recoverable when the Indonesian is ambiguous?

This judgement is a review step, not a test oracle. It never substitutes
for human comprehension evidence.

## Human comprehension evidence

Still missing and explicitly not simulated. A bilingual reviewer must
judge whether an Indonesian reader of the translation would understand the
original speaker's intent. Until that exists, the semantic status is
model-assisted only.

## What this set does not establish

- A provider accuracy rate.
- Diarization or addressee recognition.
- Behaviour on long sessions, many speakers, or real meeting audio.
- The effect of the vocabulary list on recognition.
