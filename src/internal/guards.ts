// internal/guards.ts — shared LOUD validation helpers for the B2 node model /
// definition / catalog / compile modules.
//
// INTERNAL plumbing: the public barrel does not re-export this module (node.ts
// re-exports the identifier grammar constants deliberately). The helpers mirror
// the private helpers inside contracts/artifact.ts — B1 keeps its own copies so
// its reviewed surface stays untouched.
//
// STANDALONE: relative imports only (no npm deps, no zod).

import { SHA256_HEX_PATTERN } from "../contracts/artifact.js";

/**
 * The identifier grammar shared by stage ids, node ids, slot names, pipeline
 * ids, binding ids, and capability strings — promoted byte-identically from
 * inbox-pipeline's `IdentifierSchema` (`z.string().min(1).max(160).regex(…)`).
 * Note the grammar ALLOWS `:` (e.g. `network:model`), unlike the contract-id
 * grammar.
 */
export const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
export const IDENTIFIER_MIN_LENGTH = 1;
export const IDENTIFIER_MAX_LENGTH = 160;

export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function truncate(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`${label}: must be a plain object (got ${typeName(value)})`);
  }
  return value;
}

export function assertStrictKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label}: unknown key(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")} (strict object — allowed: ${[...allowed].join(", ")})`);
  }
}

export function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label}: must be a string (got ${typeName(value)})`);
  }
  if (value.length < IDENTIFIER_MIN_LENGTH || value.length > IDENTIFIER_MAX_LENGTH) {
    throw new Error(`${label}: must be ${IDENTIFIER_MIN_LENGTH}..${IDENTIFIER_MAX_LENGTH} chars (got ${value.length}: ${JSON.stringify(truncate(value))})`);
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label}: must match the identifier grammar ${IDENTIFIER_PATTERN} — got ${JSON.stringify(truncate(value))}`);
  }
  return value;
}

export function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label}: must be a positive integer (got ${typeName(value) === "number" ? String(value) : typeName(value)})`);
  }
  return value;
}

export function assertSha256Hex(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label}: must be a string (got ${typeName(value)})`);
  }
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new Error(`${label}: must be bare lowercase sha256 hex (${SHA256_HEX_PATTERN}, NO "sha256:" prefix) — got ${JSON.stringify(truncate(value))}`);
  }
  return value;
}

export function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    const got = typeof value === "string" ? JSON.stringify(truncate(value)) : typeName(value);
    throw new Error(`${label}: must be one of ${allowed.map((v) => JSON.stringify(v)).join(" | ")} (got ${got})`);
  }
  return value as T;
}
