import type { AppError } from "@kernel/errors";
import type { Result } from "neverthrow";

export interface AppliedEvidence {
  readonly sessionId: string;
  readonly streamId: string;
  readonly seq: number;
  readonly utteranceId: string;
  readonly revision: number;
  readonly kind: "partial" | "final";
  readonly text: string;
  readonly contentHash: string;
}

export interface OperationCounts {
  readonly applied: number;
  readonly duplicates: number;
  readonly stale: number;
  readonly gaps: number;
  readonly missing: number;
}

export type Admission =
  | { readonly mode: "new" }
  | { readonly mode: "resume" }
  | {
      readonly mode: "verify";
      readonly fingerprint: string;
      readonly summary: OperationCounts & {
        readonly sessionId: string;
        readonly streamId: string;
      };
    };

export interface EvidencePersistence {
  admit(opId: string, sourceFingerprint: string): Promise<Result<Admission, AppError>>;
  record(event: AppliedEvidence, opId: string): Promise<Result<void, AppError>>;
  recordGap(input: {
    opId: string;
    sessionId: string;
    streamId: string;
    fromSeq: number;
    toSeq: number;
  }): Promise<Result<void, AppError>>;
  verify(event: AppliedEvidence): Promise<Result<void, AppError>>;
  complete(input: {
    opId: string;
    sessionId: string;
    streamId: string;
    summary: OperationCounts;
    expectedCount: number;
    expectedMaxSeq: number;
  }): Promise<Result<void, AppError>>;
  close(): Promise<void>;
}
