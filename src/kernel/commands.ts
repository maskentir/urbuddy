import { match } from "ts-pattern";

export const COMMAND_NAMES = ["doctor", "version", "replay", "capture"] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export function commandHelp(name: CommandName): string {
  return match(name)
    .with("doctor", () => "doctor [--json]  run environment checks and report status")
    .with("version", () => "version          print the urbuddy build version")
    .with("replay", () => "replay [--json] <fixture>  replay a synthetic transcript fixture")
    .with(
      "capture",
      () =>
        "capture [--duration s]  capture system-wide macOS system audio (requires --allow-child)",
    )
    .exhaustive();
}
