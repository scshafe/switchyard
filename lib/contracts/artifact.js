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
import { canonicalJson, digest } from "./digest.js";
import { snapshotValidationData } from "../internal/evidence.js";
/** Grammar of a contract id: `<name>.v<number>` (frozen $defs.contractId). */
export const CONTRACT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\.v[1-9][0-9]*$/;
export const CONTRACT_ID_MIN_LENGTH = 1;
export const CONTRACT_ID_MAX_LENGTH = 160;
/** Bare lowercase sha256 hex — NO `sha256:` prefix (frozen $defs.sha256). */
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
export function isContractId(value) {
    return (typeof value === "string" &&
        value.length >= CONTRACT_ID_MIN_LENGTH &&
        value.length <= CONTRACT_ID_MAX_LENGTH &&
        CONTRACT_ID_PATTERN.test(value));
}
/**
 * LOUD parse of the ContractId grammar. Returns `{ name, version }` (splitting
 * on the FINAL `.v<digits>` suffix — the name part may itself contain dots) or
 * throws with a precise message.
 */
export function parseContractId(value) {
    if (typeof value !== "string") {
        throw new Error(`contract id must be a string (got ${typeName(value)})`);
    }
    if (value.length < CONTRACT_ID_MIN_LENGTH || value.length > CONTRACT_ID_MAX_LENGTH) {
        throw new Error(`contract id must be ${CONTRACT_ID_MIN_LENGTH}..${CONTRACT_ID_MAX_LENGTH} chars (got ${value.length}: ${JSON.stringify(truncate(value))})`);
    }
    if (!CONTRACT_ID_PATTERN.test(value)) {
        throw new Error(`contract id must match <name>.v<number> (${CONTRACT_ID_PATTERN}) — got ${JSON.stringify(value)}`);
    }
    const match = /^(.*)\.v([1-9][0-9]*)$/.exec(value);
    if (!match) {
        // Unreachable given CONTRACT_ID_PATTERN, but fail closed rather than cast.
        throw new Error(`contract id ${JSON.stringify(value)} did not split into <name>.v<number>`);
    }
    return { name: match[1], version: Number(match[2]) };
}
/** LOUD assertion form of {@link isContractId} (labels the failing field). */
export function validateContractId(value, label = "contractId") {
    try {
        parseContractId(value);
    }
    catch (error) {
        throw new Error(`${label}: ${error.message}`);
    }
    return value;
}
const ARTIFACT_REF_KEYS = new Set(["contractId", "digest", "bytes"]);
const ARTIFACT_ENVELOPE_KEYS = new Set(["contractId", "digest", "bytes", "payload"]);
const MAX_SAFE_BYTES = 9007199254740991; // frozen artifact-ref.v1 bytes maximum
function typeName(value) {
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    return typeof value;
}
function truncate(s, max = 80) {
    return s.length <= max ? s : `${s.slice(0, max)}…`;
}
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function assertStrictKeys(value, allowed, label) {
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        throw new Error(`${label}: unknown key(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")} (strict object — allowed: ${[...allowed].join(", ")})`);
    }
}
function assertSha256Hex(value, label) {
    if (typeof value !== "string") {
        throw new Error(`${label}: digest must be a string (got ${typeName(value)})`);
    }
    if (!SHA256_HEX_PATTERN.test(value)) {
        throw new Error(`${label}: digest must be bare lowercase sha256 hex (${SHA256_HEX_PATTERN}, NO "sha256:" prefix) — got ${JSON.stringify(truncate(value))}`);
    }
    return value;
}
function assertBytes(value, label) {
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
export function assertJsonValue(value, path = "payload") {
    value = snapshotValidationData(value, path);
    if (value === null)
        return;
    const t = typeof value;
    if (t === "boolean" || t === "string")
        return;
    if (t === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`${path}: non-finite number ${String(value)} is not a JSON value`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
        return;
    }
    if (isPlainObject(value)) {
        for (const [key, child] of Object.entries(value)) {
            if (child === undefined) {
                throw new Error(`${path}.${key}: undefined is not a JSON value (omit the key instead)`);
            }
            assertJsonValue(child, `${path}.${key}`);
        }
        return;
    }
    throw new Error(`${path}: ${typeName(value)} is not a JSON value (JSON null/boolean/number/string/array/plain-object only)`);
}
/** LOUD validator for the frozen `artifact-ref.v1` shape. Returns the ref. */
export function validateArtifactRef(value) {
    const label = "artifact ref";
    value = snapshotValidationData(value, label);
    if (!isPlainObject(value)) {
        throw new Error(`${label}: must be a plain object (got ${typeName(value)})`);
    }
    assertStrictKeys(value, ARTIFACT_REF_KEYS, label);
    const contractId = validateContractId(value.contractId, `${label}: contractId`);
    const digestHex = assertSha256Hex(value.digest, label);
    const ref = { contractId, digest: digestHex };
    if ("bytes" in value) {
        if (value.bytes === undefined)
            throw new Error(`${label}: bytes is present but undefined (omit the key instead)`);
        ref.bytes = assertBytes(value.bytes, label);
    }
    return ref;
}
/**
 * LOUD validator for a digest-sealed {@link ArtifactEnvelope}. Beyond the shape
 * checks it RE-COMPUTES the payload digest (and canonical byte length, when
 * `bytes` is present) and throws "digest mismatch" on any disagreement — the
 * same fail-closed sealing semantics as the inbox runtime contracts'
 * `superRefine` digest checks.
 */
export function validateArtifactEnvelope(value) {
    const label = "artifact envelope";
    value = snapshotValidationData(value, label);
    if (!isPlainObject(value)) {
        throw new Error(`${label}: must be a plain object (got ${typeName(value)})`);
    }
    assertStrictKeys(value, ARTIFACT_ENVELOPE_KEYS, label);
    const contractId = validateContractId(value.contractId, `${label}: contractId`);
    const sealed = assertSha256Hex(value.digest, label);
    if (!("payload" in value) || value.payload === undefined) {
        throw new Error(`${label}: payload is required (a strict JSON value; use null for an empty payload)`);
    }
    assertJsonValue(value.payload, `${label}: payload`);
    const canonical = canonicalJson(value.payload);
    const computed = digest(value.payload);
    if (sealed !== computed) {
        throw new Error(`${label}: digest mismatch for ${contractId} — sealed ${sealed} != computed ${computed}`);
    }
    const envelope = { contractId, digest: sealed, payload: value.payload };
    if ("bytes" in value) {
        if (value.bytes === undefined)
            throw new Error(`${label}: bytes is present but undefined (omit the key instead)`);
        const bytes = assertBytes(value.bytes, label);
        const actual = Buffer.byteLength(canonical, "utf8");
        if (bytes !== actual) {
            throw new Error(`${label}: bytes mismatch for ${contractId} — sealed ${bytes} != canonical-JSON byte length ${actual}`);
        }
        envelope.bytes = bytes;
    }
    return envelope;
}
/**
 * Seal a payload into an {@link ArtifactEnvelope} (the promoted `create*`
 * pattern: validate inputs, compute the canonical digest, return the sealed
 * record — always with `bytes` filled in, since the canonical form is at hand).
 */
export function createArtifactEnvelope(contractId, payload) {
    validateContractId(contractId);
    payload = snapshotValidationData(payload, "payload");
    assertJsonValue(payload, "payload");
    return {
        contractId,
        digest: digest(payload),
        bytes: Buffer.byteLength(canonicalJson(payload), "utf8"),
        payload
    };
}
/** Project the content-addressed {@link ArtifactRef} out of a sealed envelope. */
export function artifactRef(envelopeRaw) {
    const envelope = validateArtifactEnvelope(envelopeRaw);
    const ref = { contractId: envelope.contractId, digest: envelope.digest };
    if (envelope.bytes !== undefined)
        ref.bytes = envelope.bytes;
    return ref;
}
