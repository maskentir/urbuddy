# Bilingual adjudication record (prepared, sign-off pending)

Date: 2026-11-28. Status: prepared. Human bilingual sign-off is **pending**
and is not simulated.

This record reuses the historical evidence from
`evaluation/language/model-selection.md`. The 46 provider invocations of
27 November are **not repeated**, the frozen prompt and corpora are
unchanged, and the frozen rubric verdicts are preserved.

## Outstanding cases

| Case                  | Arm            | Historical rubric verdict                                         | Source ambiguity                     | Target-language interpretation                            | Model-assisted analysis                                                   | Human bilingual sign-off |
| --------------------- | -------------- | ----------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------ |
| `attribution-vet-001` | Terra and Luna | FAIL, both chose possibility where the rubric requires permission | **NEEDS HUMAN REVIEW** for both arms | to be judged by a qualified bilingual reviewer            | the attribution, the version, and the timeout were preserved by both arms | **pending**              |
| `holdout-ambiguity`   | Terra and Luna | PASS, both kept the telescope attachment open                     | **NEEDS HUMAN REVIEW** for both arms | to be judged by a qualified bilingual reviewer            | the rubric passed, the source verdict is separate                         | **pending**              |
| `context-pronoun-001` | Terra          | PASS                                                              | resolved                             | "Rotasikan sertifikat TLS itu setelah Mira menyetujuinya" | Terra named the certificate; Luna omitted it                              | **pending**              |
| `context-pronoun-001` | Luna           | FAIL, the certificate was omitted and "once" became a count       | resolved                             | "Putar sekali setelah Mira menyetujui"                    | the referent stayed implicit                                              | **pending**              |
| `commitment-001`      | Terra          | PASS                                                              | resolved                             | "paling lambat tengah hari"                               | Terra kept the inclusive noon boundary                                    | **pending**              |
| `commitment-001`      | Luna           | FAIL, exactly noon was excluded                                   | resolved                             | "sebelum tengah hari"                                     | the deadline shifted                                                      | **pending**              |
| `holdout-referent`    | Terra          | PASS                                                              | resolved                             | "buku catatan biru itu"                                   | Terra named the notebook                                                  | **pending**              |
| `holdout-referent`    | Luna           | FAIL, the blue notebook stayed implicit                           | resolved                             | "itu"                                                     | the referent stayed implicit                                              | **pending**              |

## What the next qualification must and must not do

- It must adjudicate the two source-ambiguity verdicts with a qualified
  bilingual reviewer before any further spend.
- It must not change the frozen rubric, the frozen prompt, or the frozen
  corpora.
- It must not repeat the model comparison.
- It must report the critical semantic failures separately from any
  aggregate similarity measure. Word error rate against an Indonesian
  reference is a secondary signal for an English to Indonesian system.

## Minimum evidence to close Milestone 4

1. A signed bilingual adjudication for every case in the table above,
   including the two source-ambiguity verdicts.
2. One bounded translation-only qualification on captured canonical
   transcript events through the production scheduler and adapter, with
   the request, byte, and output ceilings enforced and the authorization
   scope bound to the model, the trace checksum, and the cost ceiling.
3. A report of the critical semantic failures from that run, with the
   human comprehension verdict still open.
4. A decision on the configured default model, given that neither arm has
   yet met the frozen criteria.

Until items 1 and 2 exist, the Milestone 4 semantic gate remains open.
