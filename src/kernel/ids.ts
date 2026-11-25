import { randomUUID } from "node:crypto";

import { err, ok, type Result } from "neverthrow";

import { appError, type AppError } from "./errors.js";

declare const brand: unique symbol;

export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type SessionId = Branded<string, "SessionId">;
export type CorrelationId = Branded<string, "CorrelationId">;
export type ResourceId = Branded<string, "ResourceId">;

export interface IdGenerator {
  sessionId(): SessionId;
  correlationId(): CorrelationId;
  resourceId(): ResourceId;
}

export function createCryptoIdGenerator(): IdGenerator {
  return {
    sessionId: () => randomUUID() as SessionId,
    correlationId: () => randomUUID() as CorrelationId,
    resourceId: () => randomUUID() as ResourceId,
  };
}

export function createDeterministicIdGenerator(prefix = "test"): IdGenerator {
  let counter = 0;
  const next = (scope: string): string => {
    counter += 1;
    return `${prefix}-${scope}-${counter}`;
  };
  return {
    sessionId: () => next("session") as SessionId,
    correlationId: () => next("correlation") as CorrelationId,
    resourceId: () => next("resource") as ResourceId,
  };
}

function parseBranded<B extends string>(
  brandName: B,
  value: unknown,
): Result<Branded<string, B>, AppError> {
  if (typeof value !== "string" || value.length === 0) {
    return err(
      appError("VALIDATION_FAILED", `${brandName} must be a non-empty string`, {
        details: { brand: brandName },
      }),
    );
  }
  return ok(value as Branded<string, B>);
}

export function parseSessionId(value: unknown): Result<SessionId, AppError> {
  return parseBranded("SessionId", value);
}

export function parseCorrelationId(value: unknown): Result<CorrelationId, AppError> {
  return parseBranded("CorrelationId", value);
}

export function parseResourceId(value: unknown): Result<ResourceId, AppError> {
  return parseBranded("ResourceId", value);
}
