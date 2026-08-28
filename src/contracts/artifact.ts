// artifact.ts — the ContractId grammar, content-addressed ArtifactRef, and the
// digest-sealed ArtifactEnvelope.
//
// PROMOTED from `inbox-pipeline/src/runtime/contracts.ts` (the content-addressed,
// digest-sealed contract pattern: `ArtifactContractIdSchema`, `Sha256Schema`, and
// the `{ …payload, <x>Digest: digest(payload) }` sealing + "… digest mismatch"
// refinements) and DE-ZOD-ED: plain TS types + hand-written LOUD validators that
// throw with precise messages. Field names and semantics are preserved; the
// grammar/patterns are byte-identical to the frozen `execution-contracts`
// schemas mirrored under `schemas/` (pin-tested):
//   - contractId: `^[a-z0-9][a-z0-9._-]*\.v[1-9][0-9]*$`, 1..160 chars
//   - digest: bare lowercase sha256 hex (`^[a-f0-9]{64}$`, NO `sha256:` prefix —
//     the frozen artifact-ref.v1 rule; all three repos content-address like this)
//
// STANDALONE: relative imports only (no npm deps, no zod).

import { types as nodeTypes } from "node:util";

import { canonicalJson, digest } from "./digest.js";
import { snapshotValidationData } from "../internal/evidence.js";

/** Grammar of a contract id: `<name>.v<number>` (frozen $defs.contractId). */
export const CONTRACT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\.v[1-9][0-9]*$/;
export const CONTRACT_ID_MIN_LENGTH = 1;
export const CONTRACT_ID_MAX_LENGTH = 160;

/** Bare lowercase sha256 hex — NO `sha256:` prefix (frozen $defs.sha256). */
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/** A validated `<name>.v<number>` contract id, e.g. `email-normalized.v1`. */
export type ContractId = string;

export interface ParsedContractId {
  /** Everything before the final `.v<number>` suffix, e.g. `email-normalized`. */
  name: string;
  /** The positive integer version, e.g. 1 for `….v1`. */
  version: number;
}

export function isContractId(value: unknown): value is ContractId {
  return (
    typeof value === "string" &&
    value.length >= CONTRACT_ID_MIN_LENGTH &&
    value.length <= CONTRACT_ID_MAX_LENGTH &&
    CONTRACT_ID_PATTERN.test(value)
  );
}

/**
 * LOUD parse of the ContractId grammar. Returns `{ name, version }` (splitting
 * on the FINAL `.v<digits>` suffix — the name part may itself contain dots) or
 * throws with a precise message.
 */
export function parseContractId(value: unknown): ParsedContractId {
  if (typeof value !== "string") {
    throw new Error(`contract id must be a string (got ${typeName(value)})`);
  }
  if (value.length < CONTRACT_ID_MIN_LENGTH || value.length > CONTRACT_ID_MAX_LENGTH) {
    throw new Error(
      `contract id must be ${CONTRACT_ID_MIN_LENGTH}..${CONTRACT_ID_MAX_LENGTH} chars (got ${value.length}: ${JSON.stringify(truncate(value))})`
    );
  }
  if (!CONTRACT_ID_PATTERN.test(value)) {
    throw new Error(
      `contract id must match <name>.v<number> (${CONTRACT_ID_PATTERN}) — got ${JSON.stringify(value)}`
    );
  }
  const match = /^(.*)\.v([1-9][0-9]*)$/.exec(value);
  if (!match) {
    // Unreachable given CONTRACT_ID_PATTERN, but fail closed rather than cast.
    throw new Error(`contract id ${JSON.stringify(value)} did not split into <name>.v<number>`);
  }
  return { name: match[1], version: Number(match[2]) };
}

/** LOUD assertion form of {@link isContractId} (labels the failing field). */
export function validateContractId(value: unknown, label = "contractId"): ContractId {
  try {
    parseContractId(value);
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`);
  }
  return value as ContractId;
}

/**
 * Content-addressed reference to a canonicalized artifact (mirrors the frozen
 * `artifact-ref.v1` schema exactly). `digest` is the bare sha256 hex of the
 * artifact's canonical JSON; `bytes` is the byte length of that canonical-JSON
 * serialization, when known.
 */
export interface ArtifactRef {
  contractId: ContractId;
  digest: string;
  bytes?: number;
}

/**
 * The digest-sealed artifact envelope: an {@link ArtifactRef} PLUS the payload
 * it addresses. Sealing rule (promoted from the inbox runtime contracts):
 * `digest === digest(payload)` — the object-canonical rule, recomputed and
 * asserted by {@link validateArtifactEnvelope} ("digest mismatch" fails loud).
 * `bytes`, when present, must equal the UTF-8 byte length of
 * `canonicalJson(payload)`. Payloads are strictly JSON values.
 */
export interface ArtifactEnvelope {
  contractId: ContractId;
  digest: string;
  bytes?: number;
  payload: unknown;
}

const ARTIFACT_REF_KEYS = new Set(["contractId", "digest", "bytes"]);
const ARTIFACT_ENVELOPE_KEYS = new Set(["contractId", "digest", "bytes", "payload"]);
const ARTIFACT_REF_REQUIRED_KEYS = new Set(["contractId", "digest"]);
const ARTIFACT_ENVELOPE_REQUIRED_KEYS = new Set(["contractId", "digest"]);
const MAX_SAFE_BYTES = 9007199254740991; // frozen artifact-ref.v1 bytes maximum

// Artifact payloads are the widest hostile-data boundary in the package. The
// iterative pass runs before recursive snapshot/canonicalization so excessive
// nesting fails LOUDLY instead of exhausting the JavaScript stack. Non-JSON
// leaves (Date, Map, function, etc.) remain available to assertJsonValue so its
// established, precise diagnostics do not change.
const ARTIFACT_VALIDATION_LIMITS = Object.freeze({
  maxDepth: 64,
  maxValues: 250_000,
  maxStringCodeUnits: 16_777_216
});

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertStrictKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label}: unknown key(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")} (strict object — allowed: ${[...allowed].join(", ")})`);
  }
}

function assertRequiredOwnKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
  label: string
): void {
  const missing = [...required].filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(
      `${label}: missing required key(s) ${missing.map((key) => JSON.stringify(key)).join(", ")}`
    );
  }
}

/**
 * Descriptor-only aggregate budget for artifact-shaped validation input.
 * Proxies/accessors/symbols/sparse arrays/cycles are rejected without reading
 * application data. Class instances are treated as leaves so assertJsonValue
 * can retain its long-standing "not a JSON value" diagnostic.
 */
function assertArtifactValidationBudget(value: unknown, label: string): void {
  const ancestors = new WeakSet<object>();
  type PendingFrame =
    | { kind: "visit"; candidate: unknown; path: string; depth: number }
    | { kind: "leave"; candidate: object };
  const pending: PendingFrame[] = [
    { kind: "visit", candidate: value, path: label, depth: 0 }
  ];
  let valueCount = 0;
  let stringCodeUnits = 0;

  const addString = (candidate: string, path: string): void => {
    stringCodeUnits += candidate.length;
    if (stringCodeUnits > ARTIFACT_VALIDATION_LIMITS.maxStringCodeUnits) {
      throw new Error(
        `${path}: artifact validation data exceeds the aggregate string budget of ${ARTIFACT_VALIDATION_LIMITS.maxStringCodeUnits} UTF-16 code units`
      );
    }
  };

  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.kind === "leave") {
      ancestors.delete(frame.candidate);
      continue;
    }
    const { candidate, path, depth } = frame;
    valueCount += 1;
    if (valueCount > ARTIFACT_VALIDATION_LIMITS.maxValues) {
      throw new Error(
        `${path}: artifact validation data exceeds the aggregate value budget of ${ARTIFACT_VALIDATION_LIMITS.maxValues}`
      );
    }
    if (depth > ARTIFACT_VALIDATION_LIMITS.maxDepth) {
      throw new Error(
        `${path}: artifact validation data exceeds the maximum depth of ${ARTIFACT_VALIDATION_LIMITS.maxDepth}`
      );
    }
    if (typeof candidate === "string") {
      addString(candidate, path);
      continue;
    }
    if (candidate === null || typeof candidate !== "object") continue;
    if (nodeTypes.isProxy(candidate)) {
      throw new Error(`${path}: artifact validation data must not contain Proxies`);
    }
    if (ancestors.has(candidate)) {
      throw new Error(`${path}: artifact validation data must not be cyclic`);
    }

    const isArray = Array.isArray(candidate);
    const prototype = Object.getPrototypeOf(candidate);
    const isPlainRecord = prototype === Object.prototype || prototype === null;
    if (!isArray && !isPlainRecord) continue;
    if (isArray && prototype !== Array.prototype) {
      throw new Error(`${path}: artifact validation data requires plain arrays`);
    }

    ancestors.add(candidate);
    pending.push({ kind: "leave", candidate });
    if (isArray) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
      if (
        lengthDescriptor === undefined
        || !("value" in lengthDescriptor)
        || typeof lengthDescriptor.value !== "number"
        || !Number.isInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
      ) {
        throw new Error(`${path}.length must be a data property`);
      }
      const length = lengthDescriptor.value;
      const keys = Reflect.ownKeys(candidate);
      if (
        keys.some((key) =>
          typeof key !== "string"
          || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
        )
        || keys.length !== length + 1
      ) {
        throw new Error(`${path}: artifact validation data must be a dense array without extra keys`);
      }
      if (valueCount + pending.length - 1 + length > ARTIFACT_VALIDATION_LIMITS.maxValues) {
        throw new Error(
          `${path}: artifact validation data exceeds the aggregate value budget of ${ARTIFACT_VALIDATION_LIMITS.maxValues}`
        );
      }
      for (let index = length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (
          descriptor === undefined
          || !("value" in descriptor)
          || descriptor.enumerable !== true
        ) {
          throw new Error(`${path}[${index}] must be an enumerable data property`);
        }
        pending.push({
          kind: "visit",
          candidate: descriptor.value,
          path: `${path}[${index}]`,
          depth: depth + 1
        });
      }
      continue;
    }

    const keys = Reflect.ownKeys(candidate);
    if (valueCount + pending.length - 1 + keys.length > ARTIFACT_VALIDATION_LIMITS.maxValues) {
      throw new Error(
        `${path}: artifact validation data exceeds the aggregate value budget of ${ARTIFACT_VALIDATION_LIMITS.maxValues}`
      );
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      if (typeof key !== "string") throw new Error(`${path} has symbol keys`);
      addString(key, `${path} key`);
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        throw new Error(`${path}.${key} must be an enumerable data property`);
      }
      pending.push({
        kind: "visit",
        candidate: descriptor.value,
        path: `${path}.${key}`,
        depth: depth + 1
      });
    }
  }
}

/**
 * Descriptor-safe detachment under the artifact contract's hostile-data
 * budget. Semantic envelope validation remains the caller's next step.
 */
export function snapshotArtifactValidationData<T>(value: T, label: string): T {
  assertArtifactValidationBudget(value, label);
  return snapshotValidationData(value, label);
}

function assertSha256Hex(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label}: digest must be a string (got ${typeName(value)})`);
  }
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new Error(
      `${label}: digest must be bare lowercase sha256 hex (${SHA256_HEX_PATTERN}, NO "sha256:" prefix) — got ${JSON.stringify(truncate(value))}`
    );
  }
  return value;
}

function assertBytes(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_SAFE_BYTES) {
    throw new Error(`${label}: bytes must be an integer in 0..${MAX_SAFE_BYTES} (got ${String(value)})`);
  }
  return value;
}

/**
 * LOUD guard that a payload is a strict JSON value: null, boolean, FINITE
 * number, string, array, or plain object. Anything else (undefined, NaN,
 * Infinity, functions, class instances, Dates, Maps…) would be silently
 * mangled by JSON serialization — corrupting the sealed digest — so it throws
 * with the offending path instead.
 */
function assertSnapshotJsonValue(value: unknown, path: string): void {
  if (value === null) return;
  const t = typeof value;
  if (t === "boolean" || t === "string") return;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(`${path}: non-finite number ${String(value)} is not a JSON value`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSnapshotJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        throw new Error(`${path}.${key}: undefined is not a JSON value (omit the key instead)`);
      }
      assertSnapshotJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path}: ${typeName(value)} is not a JSON value (JSON null/boolean/number/string/array/plain-object only)`);
}

/**
 * LOUD guard for one bounded strict JSON value. Validation is descriptor-safe:
 * accessors and Proxies are rejected without executing caller code.
 */
export function assertJsonValue(value: unknown, path = "payload"): void {
  const snapshot = snapshotArtifactValidationData(value, path);
  assertSnapshotJsonValue(snapshot, path);
}

/** LOUD validator for the frozen `artifact-ref.v1` shape. Returns the ref. */
export function validateArtifactRef(value: unknown): ArtifactRef {
  const label = "artifact ref";
  value = snapshotArtifactValidationData(value, label);
  if (!isPlainObject(value)) {
    throw new Error(`${label}: must be a plain object (got ${typeName(value)})`);
  }
  assertStrictKeys(value, ARTIFACT_REF_KEYS, label);
  assertRequiredOwnKeys(value, ARTIFACT_REF_REQUIRED_KEYS, label);
  const contractId = validateContractId(value.contractId, `${label}: contractId`);
  const digestHex = assertSha256Hex(value.digest, label);
  let bytes: number | undefined;
  if (Object.hasOwn(value, "bytes")) {
    if (value.bytes === undefined) throw new Error(`${label}: bytes is present but undefined (omit the key instead)`);
    bytes = assertBytes(value.bytes, label);
  }
  return Object.freeze({
    contractId,
    digest: digestHex,
    ...(bytes === undefined ? {} : { bytes })
  });
}

/**
 * LOUD validator for a digest-sealed {@link ArtifactEnvelope}. Beyond the shape
 * checks it RE-COMPUTES the payload digest (and canonical byte length, when
 * `bytes` is present) and throws "digest mismatch" on any disagreement — the
 * same fail-closed sealing semantics as the inbox runtime contracts'
 * `superRefine` digest checks.
 */
export function validateArtifactEnvelope(value: unknown): ArtifactEnvelope {
  const label = "artifact envelope";
  value = snapshotArtifactValidationData(value, label);
  if (!isPlainObject(value)) {
    throw new Error(`${label}: must be a plain object (got ${typeName(value)})`);
  }
  assertStrictKeys(value, ARTIFACT_ENVELOPE_KEYS, label);
  assertRequiredOwnKeys(value, ARTIFACT_ENVELOPE_REQUIRED_KEYS, label);
  const contractId = validateContractId(value.contractId, `${label}: contractId`);
  const sealed = assertSha256Hex(value.digest, label);
  if (!Object.hasOwn(value, "payload") || value.payload === undefined) {
    throw new Error(`${label}: payload is required (a strict JSON value; use null for an empty payload)`);
  }
  assertSnapshotJsonValue(value.payload, `${label}: payload`);
  const canonical = canonicalJson(value.payload);
  const computed = digest(value.payload);
  if (sealed !== computed) {
    throw new Error(`${label}: digest mismatch for ${contractId} — sealed ${sealed} != computed ${computed}`);
  }
  let bytes: number | undefined;
  if (Object.hasOwn(value, "bytes")) {
    if (value.bytes === undefined) throw new Error(`${label}: bytes is present but undefined (omit the key instead)`);
    bytes = assertBytes(value.bytes, label);
    const actual = Buffer.byteLength(canonical, "utf8");
    if (bytes !== actual) {
      throw new Error(`${label}: bytes mismatch for ${contractId} — sealed ${bytes} != canonical-JSON byte length ${actual}`);
    }
  }
  return Object.freeze({
    contractId,
    digest: sealed,
    payload: value.payload,
    ...(bytes === undefined ? {} : { bytes })
  });
}

/**
 * Seal a payload into an {@link ArtifactEnvelope} (the promoted `create*`
 * pattern: validate inputs, compute the canonical digest, return the sealed
 * record — always with `bytes` filled in, since the canonical form is at hand).
 */
export function createArtifactEnvelope(contractId: ContractId, payload: unknown): ArtifactEnvelope {
  validateContractId(contractId);
  payload = snapshotArtifactValidationData(payload, "payload");
  assertSnapshotJsonValue(payload, "payload");
  return Object.freeze({
    contractId,
    digest: digest(payload),
    bytes: Buffer.byteLength(canonicalJson(payload), "utf8"),
    payload
  });
}

/** Project the content-addressed {@link ArtifactRef} out of a sealed envelope. */
export function artifactRef(envelopeRaw: ArtifactEnvelope): ArtifactRef {
  const envelope = validateArtifactEnvelope(envelopeRaw);
  return Object.freeze({
    contractId: envelope.contractId,
    digest: envelope.digest,
    ...(Object.hasOwn(envelope, "bytes") ? { bytes: envelope.bytes } : {})
  });
}
