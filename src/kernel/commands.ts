import { match } from "ts-pattern";

export const COMMAND_NAMES = ["doctor", "version"] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export function commandHelp(name: CommandName): string {
  return match(name)
    .with("doctor", () => "doctor [--json]  run environment checks and report status")
    .with("version", () => "version          print the urbuddy build version")
    .exhaustive();
}
