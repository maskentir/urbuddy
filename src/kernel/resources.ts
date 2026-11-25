import { z } from "zod";

export const RESOURCE_KINDS = ["timer"] as const;

export const resourceKindSchema = z.enum(RESOURCE_KINDS);

export type ResourceKind = z.infer<typeof resourceKindSchema>;
