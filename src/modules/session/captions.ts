import { translationMatchesRevision, type TranslationEvent } from "@modules/language/translation";

import type { SessionOutput } from "./events.js";

type CaptionTranslation =
  | { readonly state: "unavailable" | "pending" | "superseded" }
  | { readonly state: "failed"; readonly reason: string }
  | {
      readonly state: "committed" | "provisional";
      readonly text: string;
      readonly uncertain: boolean;
    };

export interface Caption {
  readonly id: string;
  readonly revision: number;
  readonly text: string;
  readonly final: boolean;
  readonly atMs: number;
  readonly translation: CaptionTranslation;
}

export interface CaptionSnapshot {
  readonly rows: readonly Caption[];
  readonly gaps: number;
  readonly lastGap?: string;
  readonly dropped: number;
  readonly status: "starting" | "running" | "settling" | "completed" | "stopped" | "failed";
  readonly detail?: string;
}

const HISTORY_CAPACITY = 120;

export class CaptionHistory {
  private readonly rows: Caption[] = [];
  private gaps = 0;
  private lastGap: string | undefined;
  private dropped = 0;
  private status: CaptionSnapshot["status"] = "starting";
  private detail: string | undefined;

  constructor(private readonly translate: boolean) {}

  accept(output: SessionOutput, atMs: number): void {
    if (output.type !== "applied") return;
    const index = this.rows.findIndex((row) => row.id === output.utteranceId);
    const previous = this.rows[index];
    const final = output.kind === "final";
    const translation: CaptionTranslation =
      this.translate && final
        ? { state: "pending" }
        : previous?.translation.state === "provisional"
          ? { state: "superseded" }
          : { state: "unavailable" };
    const row = {
      id: output.utteranceId,
      revision: output.revision,
      text: output.text,
      final,
      atMs: previous?.atMs ?? atMs,
      translation,
    };
    if (index >= 0) {
      this.rows[index] = row;
      return;
    }
    this.rows.push(row);
    if (this.rows.length > HISTORY_CAPACITY) {
      this.rows.shift();
      this.dropped += 1;
    }
  }

  publish(event: TranslationEvent): void {
    const index = this.rows.findIndex((row) => row.id === event.sourceUtteranceId);
    const row = this.rows[index];
    if (
      row === undefined ||
      !translationMatchesRevision(event, row.revision, row.translation.state)
    )
      return;
    if (event.type === "committed" && !row.final) return;
    if (event.type === "provisional" && row.final) return;
    switch (event.type) {
      case "committed":
      case "provisional":
        this.rows[index] = {
          ...row,
          translation: { state: event.type, text: event.text, uncertain: event.coverageUncertain },
        };
        return;
      case "degraded":
        this.rows[index] = { ...row, translation: { state: "failed", reason: event.reason } };
        return;
      case "invalidated":
        if (row.translation.state === "provisional") {
          this.rows[index] = { ...row, translation: { state: "superseded" } };
        }
    }
  }

  gap(detail: string): void {
    this.gaps += 1;
    this.lastGap = detail;
  }

  setStatus(status: CaptionSnapshot["status"], detail?: string): void {
    this.status = status;
    this.detail = detail;
    if (status === "stopped" || status === "completed" || status === "failed") {
      for (const [index, row] of this.rows.entries()) {
        if (row.translation.state !== "pending") continue;
        this.rows[index] = {
          ...row,
          translation:
            status === "stopped"
              ? { state: "unavailable" }
              : { state: "failed", reason: "translation-not-delivered" },
        };
      }
    }
  }

  snapshot(): CaptionSnapshot {
    return {
      rows: [...this.rows],
      gaps: this.gaps,
      dropped: this.dropped,
      status: this.status,
      ...(this.lastGap === undefined ? {} : { lastGap: this.lastGap }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
    };
  }
}
