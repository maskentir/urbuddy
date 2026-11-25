import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { z } from "zod";

import { appError, type AppError } from "./errors.js";

export const COMMAND_NAMES = ["doctor", "version"] as const;

export const commandRequestSchema = z.object({
  name: z.enum(COMMAND_NAMES),
  json: z.boolean(),
});

export type CommandName = z.infer<typeof commandRequestSchema>["name"];

export interface CommandRequest {
  readonly name: CommandName;
  readonly json: boolean;
}

export function parseCommandRequest(data: unknown): Result<CommandRequest, AppError> {
  const parsed = commandRequestSchema.safeParse(data);
  if (!parsed.success) {
    return err(
      appError("VALIDATION_FAILED", "unknown command request", {
        details: { issues: parsed.error.issues.map((issue) => issue.message).join("; ") },
      }),
    );
  }
  return ok({ name: parsed.data.name, json: parsed.data.json });
}

export function commandHelp(name: CommandName): string {
  return match(name)
    .with("doctor", () => "doctor [--json]  run environment checks and report status")
    .with("version", () => "version          print the urbuddy build version")
    .exhaustive();
}
