export const NORMALIZATION_POLICY_VERSION = "norm-v2";

/**
 * [correctness] Normalization policy norm-v2, so a word error rate is
 * reproducible and punctuation differences are never counted as errors.
 *
 * 1. Unicode NFKC, then lowercase.
 * 2. Typographic quotes and dashes fold to ASCII.
 * 3. Apostrophes are removed inside a word: "don't" becomes "dont".
 * 4. Tokens are split on whitespace.
 * 5. Sentence punctuation is stripped from token edges: . , ; : ! ? " ( ) [ ] { }
 *    A trailing period therefore never survives as a word.
 * 6. Intra-token punctuation is preserved, because it carries meaning for
 *    technical and numeric text: 3.5, 50%, 24/7, c++, node.js, e2e, p99.
 * 7. No number, spelling, or abbreviation expansion is performed.
 * 8. Empty tokens are dropped.
 */
const EDGE_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  '"',
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "'",
]);

export function normalizeWords(text: string): string[] {
  const folded = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, "-");
  const withoutApostrophes = folded.replace(/'/g, "");
  const tokens: string[] = [];
  for (const raw of withoutApostrophes.split(/\s+/)) {
    let token = raw;
    while (token.length > 0 && EDGE_PUNCTUATION.has(token[0] ?? "")) {
      token = token.slice(1);
    }
    while (token.length > 0 && EDGE_PUNCTUATION.has(token[token.length - 1] ?? "")) {
      token = token.slice(0, -1);
    }
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
}

export interface Substitution {
  readonly reference: string;
  readonly hypothesis: string;
  readonly referenceIndex: number;
  readonly hypothesisIndex: number;
}

export interface WordEdits {
  readonly substitutions: readonly Substitution[];
  readonly deletions: readonly string[];
  readonly insertions: readonly string[];
  readonly editDistance: number;
}

export interface AlignmentPair {
  readonly referenceIndex: number;
  readonly hypothesisIndex: number;
  readonly operation: "match" | "substitute";
}

export interface Alignment {
  readonly edits: WordEdits;
  readonly pairs: readonly AlignmentPair[];
}

interface MatrixCell {
  readonly cost: number;
  readonly operation: "match" | "substitute" | "delete" | "insert";
}

/**
 * [correctness] A substitution is one edit and is never counted again as a
 * deletion or an insertion, so the edit distance always equals the sum of
 * the three operation counts.
 */
export function alignWords(reference: readonly string[], hypothesis: readonly string[]): Alignment {
  const rows = reference.length + 1;
  const columns = hypothesis.length + 1;
  const table: MatrixCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => ({ cost: 0, operation: "match" as const })),
  );
  for (let row = 1; row < rows; row += 1) {
    table[row]![0] = { cost: row, operation: "delete" };
  }
  for (let column = 1; column < columns; column += 1) {
    table[0]![column] = { cost: column, operation: "insert" };
  }
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const referenceWord = reference[row - 1] ?? "";
      const hypothesisWord = hypothesis[column - 1] ?? "";
      const diagonal =
        table[row - 1]![column - 1]!.cost + (referenceWord === hypothesisWord ? 0 : 1);
      const deletion = table[row - 1]![column]!.cost + 1;
      const insertion = table[row]![column - 1]!.cost + 1;
      const best = Math.min(diagonal, deletion, insertion);
      const operation =
        best === diagonal
          ? referenceWord === hypothesisWord
            ? "match"
            : "substitute"
          : best === deletion
            ? "delete"
            : "insert";
      table[row]![column] = { cost: best, operation };
    }
  }
  const substitutions: Substitution[] = [];
  const deletions: string[] = [];
  const insertions: string[] = [];
  const pairs: AlignmentPair[] = [];
  let row = reference.length;
  let column = hypothesis.length;
  while (row > 0 || column > 0) {
    const cell = table[row]![column]!;
    if (row > 0 && column > 0 && cell.operation !== "delete" && cell.operation !== "insert") {
      if (cell.operation === "substitute") {
        substitutions.push({
          reference: reference[row - 1] ?? "",
          hypothesis: hypothesis[column - 1] ?? "",
          referenceIndex: row - 1,
          hypothesisIndex: column - 1,
        });
      }
      pairs.push({
        referenceIndex: row - 1,
        hypothesisIndex: column - 1,
        operation: cell.operation,
      });
      row -= 1;
      column -= 1;
      continue;
    }
    if (row > 0 && (column === 0 || cell.operation === "delete")) {
      deletions.push(reference[row - 1] ?? "");
      row -= 1;
      continue;
    }
    insertions.push(hypothesis[column - 1] ?? "");
    column -= 1;
  }
  const editDistance = substitutions.length + deletions.length + insertions.length;
  const tableCost = table[rows - 1]![columns - 1]!.cost;
  if (editDistance !== tableCost) {
    throw new Error(`alignment accounting mismatch: ${editDistance} edits but cost ${tableCost}`);
  }
  return {
    edits: { substitutions, deletions, insertions, editDistance },
    pairs: pairs.toSorted((left, right) => left.referenceIndex - right.referenceIndex),
  };
}

export function wordErrorRate(
  referenceWords: readonly string[],
  hypothesisWords: readonly string[],
): {
  readonly rate: number;
  readonly alignment: Alignment;
} {
  const alignment = alignWords(referenceWords, hypothesisWords);
  const rate =
    referenceWords.length === 0 ? 0 : alignment.edits.editDistance / referenceWords.length;
  return { rate, alignment };
}
