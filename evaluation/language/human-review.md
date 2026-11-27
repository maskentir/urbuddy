# Human bilingual review packet

**Status: pending.** Use the retained synthetic outputs below. No new
model calls are needed. The historical Luna result remains **12/15**.
The frozen comparison remains **12/15 regression and 5/6 holdout** for
Luna and **14/15 regression and 6/6 holdout** for Terra. Neither met the
frozen gate. Record any human adjudication separately from those scores.

## English to Indonesian

Read the source and supplied context first. Output order varies by case.
For each output, record (1) the readings a target-language speaker could
reasonably recover, (2) whether context licenses any added specificity,
and (3) any changed relationship or condition and its severity.

### Modality and genuine ambiguity

**`attribution-vet-001`** · “Rina said the vet may test API v2.4 with a
500 ms timeout, but Omar must approve it.”

- “Rina berkata bahwa dokter hewan mungkin akan menguji API v2.4 dengan batas waktu 500 ms, tetapi Omar harus menyetujuinya.”
- “Rina mengatakan bahwa dokter hewan mungkin menguji API v2.4 dengan batas waktu 500 ms, tetapi Omar harus menyetujuinya.”
- Historical output: “Rina mengatakan bahwa dokter hewan mungkin akan menguji API v2.4 dengan batas waktu 500 ms, tetapi Omar harus menyetujuinya.”

Can the English establish permission, possibility, or both? Does Omar’s
approval obligation resolve the reading? Can any Indonesian output
retain the same readings? Verify the actors, obligation, version, and
timeout separately. The frozen rubric required permission. The separate
source-ambiguity verdict remains **NEEDS HUMAN REVIEW**.

**Controls.** Review the existing outputs for explicit [permission, possibility,
and telescope attachment](./model-selection.md#holdout-v1). Check that
the first two retain their disambiguating cues and that the telescope
sentence leaves both attachments available.

### Context-supported specificity

**`context-pronoun-001`** · “Rotate it once Mira approves.”
Context: “The TLS certificate expires tomorrow.”

- “Putar sekali setelah Mira menyetujui.”
- “Rotasikan sertifikat TLS itu setelah Mira menyetujuinya.”
- Historical output: “Putar sekali setelah Mira menyetujuinya.”

Check whether naming the certificate is supported, whether a pronoun would
resolve naturally in Indonesian, and whether `sekali` changes a temporal
condition into a count. Evaluate those questions separately.

**`holdout-referent`** · “Please bring it to me.”
Context: “Rina left the blue notebook on the shelf.”

- “Tolong bawakan buku catatan biru itu kepada saya.”
- “Tolong bawakan itu kepada saya.”

Both variants should preserve the speaker as recipient. Judge whether
the second leaves the object recoverable with the supplied context and
whether it meets the frozen requirement to identify the notebook.

### Temporal meaning

**`commitment-001`** · “I will send the design doc by noon.”

- “Saya akan mengirim dokumen desain sebelum tengah hari.” This wording also appears in the historical run with `itu` after `desain`.
- “Saya akan mengirimkan dokumen desain paling lambat tengah hari.”

Can the speaker send the document at exactly noon under each output?
Check that the speaker still owns the commitment.

## Record the decision

Record the reviewer, language pairs, date, case and output, semantic
verdict, rationale, and optional fluency note. Use **PASS**, **FAIL**,
or **NEEDS HUMAN REVIEW**. Mark when a judgment depends on displaying
the preceding context. For full sign-off, review the remaining
comparison rows in the relevant language pairs, including
Japanese–Korean and Traditional Chinese–English. Keep case-level
adjudication and any proposed qualification decision separate.
[Frozen regression and holdout outputs](./model-selection.md#blinded-semantic-review) · [Historical evidence and rubric distinction](./readiness.md#review-of-the-original-run)
