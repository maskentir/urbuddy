import { z } from "zod";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export const logLevelSchema = z.enum(LOG_LEVELS);

export type LogLevel = z.infer<typeof logLevelSchema>;
