// graph/edge.ts — v2 graph edges and the deliberately tiny predicate language.
//
// Routing predicates are sealed JSON data only: exact outcome, any-of outcomes,
// or exact outcome plus conjunctive RFC 6901 field equality tests over the
// sealed output ArtifactEnvelope. No regex, ranges, coercion, callbacks, or
// user code are admitted here.

import {
  assertIdentifier,
  assertPlainObject,
  assertRequiredKeys,
  assertStrictKeys,
  typeName
} from "../internal/guards.js";
import { deepFrozenClone } from "../internal/evidence.js";
import { snapshotGraphValidationData } from "./limits.js";
import { MAX_NODE_OUTCOMES } from "./outcome.js";

export const MAX_EDGE_TARGETS = 64;
export const MAX_FIELD_MATCHES = 32;
export const MAX_JSON_POINTER_LENGTH = 1_024;
export const MAX_JSON_POINTER_TOKENS = 64;
export const MAX_EDGE_SCALAR_STRING_LENGTH = 16_384;

export type JsonScalar = string | number | boolean | null;

export interface FieldMatch {
  readonly pointer: string;
  readonly equals: JsonScalar;
}

export type OutcomePredicate =
  | { readonly outcome: string }
  | { readonly anyOf: readonly string[] }
  | { readonly outcome: string; readonly where: readonly FieldMatch[] };

export interface Edge {
  /** Stable author-supplied identity used by durable join bookkeeping. */
  readonly edgeId: string;
  readonly from: string;
  readonly when: OutcomePredicate;
  readonly to: readonly string[];
}

const EDGE_KEYS = new Set(["edgeId", "from", "when", "to"]);
const OUTCOME_KEYS = new Set(["outcome"]);
const ANY_OF_KEYS = new Set(["anyOf"]);
const OUTCOME_WHERE_KEYS = new Set(["outcome", "where"]);
const FIELD_MATCH_KEYS = new Set(["pointer", "equals"]);

/** RFC 6901 JSON Pointer syntax, including the valid empty root pointer. */
export function validateJsonPointer(value: unknown, label = "JSON pointer"): string {
  if (typeof value !== "string") {
    throw new Error(`${label}: must be a string (got ${typeName(value)})`);
  }
  if (value.length > MAX_JSON_POINTER_LENGTH) {
    throw new Error(
      `${label}: must be at most ${MAX_JSON_POINTER_LENGTH} characters (got ${value.length})`
    );
  }
  if (value !== "" && !value.startsWith("/")) {
    throw new Error(
      `${label}: must be an RFC 6901 pointer (empty or beginning with "/"; URI fragments are not accepted)`
    );
  }
  const tokens = value === "" ? [] : value.slice(1).split("/");
  if (tokens.length > MAX_JSON_POINTER_TOKENS) {
    throw new Error(
      `${label}: must contain at most ${MAX_JSON_POINTER_TOKENS} reference tokens (got ${tokens.length})`
    );
  }
  if (tokens.some((token) => /~(?![01])/u.test(token))) {
    throw new Error(`${label}: contains an invalid RFC 6901 "~" escape (only ~0 and ~1 are allowed)`);
  }
  return value;
}

/** Strict JSON scalar validator used by FieldMatch.equals. */
export function validateJsonScalar(value: unknown, label = "JSON scalar"): JsonScalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_EDGE_SCALAR_STRING_LENGTH) {
      throw new Error(
        `${label}: string must be at most ${MAX_EDGE_SCALAR_STRING_LENGTH} characters (got ${value.length})`
      );
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // JSON.stringify canonicalizes -0 to 0. Normalize before sealing so the
    // in-memory contract and its canonical JSON have exactly one value.
    return Object.is(value, -0) ? 0 : value;
  }
  throw new Error(
    `${label}: must be a finite JSON scalar (null, string, number, or boolean; got ${typeName(value)})`
  );
}

function validateFieldMatch(value: unknown, label: string): FieldMatch {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, FIELD_MATCH_KEYS, label);
  assertRequiredKeys(raw, FIELD_MATCH_KEYS, label);
  return {
    pointer: validateJsonPointer(raw.pointer, `${label}.pointer`),
    equals: validateJsonScalar(raw.equals, `${label}.equals`)
  };
}

/** Validate one arm of the closed v2 predicate language. */
export function validateOutcomePredicate(
  value: unknown,
  label = "outcome predicate"
): OutcomePredicate {
  value = snapshotGraphValidationData(value, label);
  const raw = assertPlainObject(value, label);
  if (Object.hasOwn(raw, "anyOf")) {
    assertStrictKeys(raw, ANY_OF_KEYS, label);
    if (
      !Array.isArray(raw.anyOf)
      || raw.anyOf.length < 1
      || raw.anyOf.length > MAX_NODE_OUTCOMES
    ) {
      throw new Error(
        `${label}: anyOf must be an array of 1..${MAX_NODE_OUTCOMES} outcomes (got ${Array.isArray(raw.anyOf) ? raw.anyOf.length : typeName(raw.anyOf)})`
      );
    }
    const anyOf = raw.anyOf.map((outcome, index) =>
      assertIdentifier(outcome, `${label}: anyOf[${index}]`)
    );
    if (new Set(anyOf).size !== anyOf.length) {
      throw new Error(`${label}: anyOf outcomes must be unique`);
    }
    return deepFrozenClone({ anyOf }, label);
  }
  if (Object.hasOwn(raw, "outcome") && Object.hasOwn(raw, "where")) {
    assertStrictKeys(raw, OUTCOME_WHERE_KEYS, label);
    const outcome = assertIdentifier(raw.outcome, `${label}: outcome`);
    if (
      !Array.isArray(raw.where)
      || raw.where.length < 1
      || raw.where.length > MAX_FIELD_MATCHES
    ) {
      throw new Error(
        `${label}: where must be an array of 1..${MAX_FIELD_MATCHES} field matches (got ${Array.isArray(raw.where) ? raw.where.length : typeName(raw.where)})`
      );
    }
    const where = raw.where.map((match, index) =>
      validateFieldMatch(match, `${label}: where[${index}]`)
    );
    return deepFrozenClone({ outcome, where }, label);
  }
  if (Object.hasOwn(raw, "outcome")) {
    assertStrictKeys(raw, OUTCOME_KEYS, label);
    return deepFrozenClone(
      { outcome: assertIdentifier(raw.outcome, `${label}: outcome`) },
      label
    );
  }
  throw new Error(
    `${label}: must be exactly {outcome}, {anyOf}, or {outcome, where} (closed predicate language)`
  );
}

/** Outcomes mentioned by a predicate, in authored order. */
export function predicateOutcomes(predicate: OutcomePredicate): readonly string[] {
  if (Object.hasOwn(predicate, "anyOf")) {
    return (predicate as { readonly anyOf: readonly string[] }).anyOf;
  }
  return [(predicate as { readonly outcome: string }).outcome];
}

/** Conditional where-arms are additive and do not prove total coverage. */
export function isUnconditionalOutcomePredicate(predicate: OutcomePredicate): boolean {
  return Object.hasOwn(predicate, "anyOf") || !Object.hasOwn(predicate, "where");
}

/** Validate, detach, and freeze one graph edge. */
export function validateEdge(value: unknown, label = "graph edge"): Edge {
  value = snapshotGraphValidationData(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, EDGE_KEYS, label);
  assertRequiredKeys(raw, EDGE_KEYS, label);
  const edgeId = assertIdentifier(raw.edgeId, `${label}: edgeId`);
  const from = assertIdentifier(raw.from, `${label} ${edgeId}: from`);
  const when = validateOutcomePredicate(raw.when, `${label} ${edgeId}: when`);
  if (
    !Array.isArray(raw.to)
    || raw.to.length < 1
    || raw.to.length > MAX_EDGE_TARGETS
  ) {
    throw new Error(
      `${label} ${edgeId}: to must be an array of 1..${MAX_EDGE_TARGETS} node IDs (got ${Array.isArray(raw.to) ? raw.to.length : typeName(raw.to)})`
    );
  }
  const to = raw.to.map((target, index) =>
    assertIdentifier(target, `${label} ${edgeId}: to[${index}]`)
  );
  if (new Set(to).size !== to.length) {
    throw new Error(`${label} ${edgeId}: target node IDs must be unique`);
  }
  return deepFrozenClone({ edgeId, from, when, to }, label);
}
