import { z } from "zod";

export const streamEventSchema = z.object({
  sessionId: z.string().min(1),
  streamId: z.string().min(1),
  seq: z.number().int().min(0),
  kind: z.enum(["partial", "final"]),
  utteranceId: z.string().min(1),
  revision: z.number().int().min(0),
  text: z.string(),
});

export type StreamEvent = z.infer<typeof streamEventSchema>;

export type SessionOutput =
  | {
      readonly type: "applied";
      readonly seq: number;
      readonly utteranceId: string;
      readonly revision: number;
      readonly kind: "partial" | "final";
      readonly text: string;
    }
  | {
      readonly type: "duplicate";
      readonly seq: number;
      readonly utteranceId: string;
      readonly revision: number;
    }
  | {
      readonly type: "stale";
      readonly seq: number;
      readonly utteranceId: string;
      readonly revision: number;
      readonly reason: "superseded" | "finalized";
    }
  | { readonly type: "gap"; readonly from: number; readonly to: number }
  | { readonly type: "completed"; readonly summary: ReplaySummary };

export interface ReplaySummary {
  readonly sessionId: string;
  readonly streamId: string;
  readonly applied: number;
  readonly duplicates: number;
  readonly stale: number;
  readonly gaps: number;
  readonly missing: number;
}
