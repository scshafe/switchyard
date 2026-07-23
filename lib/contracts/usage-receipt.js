// contracts/usage-receipt.ts — the UsageReceipt runtime type + LOUD validator,
// hand-written against the FROZEN `usage-receipt.v1` schema mirror
// (schemas/usage-receipt.v1.schema.json — pin-tested byte-for-byte in B1).
//
// PROMOTED from inbox-pipeline/src/usage-receipt.ts (the zod mirror), DE-ZOD-ED
// to a plain TS type + hand validator. The validator reproduces the frozen
// schema's cross-field `allOf` rules (observed-telemetry presence per trust
// tier; a signature present exactly when trust=provider_signed) AND enforces
// the CODE-SIDE-ONLY rules the frozen schema deliberately cannot express
// (CONVENTIONS §5; freeze resolution #7):
//   - the NON-SILENT-ZERO FLOOR: for trust ∈ {estimated_tier_ceiling,
//     unavailable} the charged values MUST be >= 1 — "no telemetry" can never
//     masquerade as free usage (the schema's minimum:0 still admits 0; the
//     floor lives here);
//   - charged-covers-observed: when BOTH observed token counts are present,
//     chargedTokens must cover their sum.
//
// The whole point of the trust tier is that missing telemetry is never a
// silent zero: `chargedTokens` / `chargedCostMicroUsd` are ALWAYS non-null.
// Absence is expressed by the `trust` tier, not by a 0.
//
// STANDALONE: relative imports only (no npm deps, no zod).
import { assertEnum, assertPlainObject, assertStrictKeys, typeName, truncate } from "../internal/guards.js";
export const USAGE_RECEIPT_SCHEMA_VERSION = "usage-receipt.v1";
/** The frozen trust tiers, in descending trust order. */
export const USAGE_TRUST_TIERS = [
    "provider_signed",
    "provider_reported",
    "estimated_tier_ceiling",
    "unavailable"
];
/** The FROZEN `usage-receipt.v1` numeric bounds (source of truth: the schema mirror). */
export const USAGE_RECEIPT_BOUNDS = Object.freeze({
    maxChargedTokens: 10_000_000,
    maxChargedCostMicroUsd: 100_000_000_000,
    maxDurationMs: 86_400_000
});
export const USAGE_ROUTE_ALIAS_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
 * The config-pinned floor for a receipt with no telemetry and no tier ceiling
 * (promoted UNAVAILABLE_USAGE_FLOOR). A policy value, never an observation.
 */
export const UNAVAILABLE_USAGE_FLOOR = Object.freeze({
    chargedTokens: 1,
    chargedCostMicroUsd: 1
});
const RECEIPT_KEYS = new Set([
    "schemaVersion",
    "trust",
    "observedInputTokens",
    "observedOutputTokens",
    "chargedTokens",
    "observedCostMicroUsd",
    "chargedCostMicroUsd",
    "durationMs",
    "routeAlias",
    "signature"
]);
function assertBoundedInt(value, min, max, label) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${label}: must be an integer in ${min}..${max} (got ${typeName(value) === "number" ? String(value) : typeName(value)})`);
    }
    return value;
}
function assertNullableBoundedInt(value, max, label) {
    if (value === null)
        return null;
    return assertBoundedInt(value, 0, max, label);
}
/**
 * LOUD validator for a frozen `usage-receipt.v1` payload: full shape + the
 * trust-tier `allOf` rules + the CODE-SIDE floor and charged-covers-observed
 * rules (see the module header). Returns a fresh normalized receipt or throws
 * with a precise message.
 */
export function validateUsageReceipt(value) {
    const label = "usage receipt";
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, RECEIPT_KEYS, label);
    if (raw.schemaVersion !== USAGE_RECEIPT_SCHEMA_VERSION) {
        throw new Error(`${label}: schemaVersion must be ${JSON.stringify(USAGE_RECEIPT_SCHEMA_VERSION)} (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`);
    }
    const trust = assertEnum(raw.trust, USAGE_TRUST_TIERS, `${label}: trust`);
    const observedInputTokens = assertNullableBoundedInt(raw.observedInputTokens, USAGE_RECEIPT_BOUNDS.maxChargedTokens, `${label}: observedInputTokens`);
    const observedOutputTokens = assertNullableBoundedInt(raw.observedOutputTokens, USAGE_RECEIPT_BOUNDS.maxChargedTokens, `${label}: observedOutputTokens`);
    const chargedTokens = assertBoundedInt(raw.chargedTokens, 0, USAGE_RECEIPT_BOUNDS.maxChargedTokens, `${label}: chargedTokens`);
    const observedCostMicroUsd = assertNullableBoundedInt(raw.observedCostMicroUsd, USAGE_RECEIPT_BOUNDS.maxChargedCostMicroUsd, `${label}: observedCostMicroUsd`);
    const chargedCostMicroUsd = assertBoundedInt(raw.chargedCostMicroUsd, 0, USAGE_RECEIPT_BOUNDS.maxChargedCostMicroUsd, `${label}: chargedCostMicroUsd`);
    const durationMs = assertBoundedInt(raw.durationMs, 0, USAGE_RECEIPT_BOUNDS.maxDurationMs, `${label}: durationMs`);
    // Frozen allOf #1: the no-observation tiers carry NO observed telemetry.
    if (trust === "estimated_tier_ceiling" || trust === "unavailable") {
        if (observedInputTokens !== null || observedOutputTokens !== null || observedCostMicroUsd !== null) {
            throw new Error(`${label}: ${trust} receipt cannot carry observed telemetry`);
        }
        // CODE-SIDE floor (CONVENTIONS §5; freeze resolution #7): never a silent zero.
        if (chargedTokens < 1) {
            throw new Error(`${label}: ${trust} receipt must charge at least 1 token (non-null floor, never a silent zero)`);
        }
        if (chargedCostMicroUsd < 1) {
            throw new Error(`${label}: ${trust} receipt must charge at least 1 micro-USD (non-null floor, never a silent zero)`);
        }
    }
    // Frozen allOf #2: the observation tiers carry at least one observed value.
    if (trust === "provider_reported" || trust === "provider_signed") {
        if (observedInputTokens === null && observedOutputTokens === null && observedCostMicroUsd === null) {
            throw new Error(`${label}: ${trust} receipt requires at least one observed value`);
        }
    }
    // CODE-SIDE charged-covers-observed (CONVENTIONS §5).
    if (observedInputTokens !== null && observedOutputTokens !== null) {
        const observedTotal = observedInputTokens + observedOutputTokens;
        if (chargedTokens < observedTotal) {
            throw new Error(`${label}: chargedTokens (${chargedTokens}) must cover observed token total (${observedTotal})`);
        }
    }
    const receipt = {
        schemaVersion: USAGE_RECEIPT_SCHEMA_VERSION,
        trust,
        observedInputTokens,
        observedOutputTokens,
        chargedTokens,
        observedCostMicroUsd,
        chargedCostMicroUsd,
        durationMs
    };
    if ("routeAlias" in raw) {
        if (typeof raw.routeAlias !== "string" || raw.routeAlias.length < 1 || raw.routeAlias.length > 100 || !USAGE_ROUTE_ALIAS_PATTERN.test(raw.routeAlias)) {
            throw new Error(`${label}: routeAlias must be a 1..100 char string matching ${USAGE_ROUTE_ALIAS_PATTERN} (got ${typeof raw.routeAlias === "string" ? JSON.stringify(truncate(raw.routeAlias)) : typeName(raw.routeAlias)})`);
        }
        receipt.routeAlias = raw.routeAlias;
    }
    // Frozen allOf #3: a signature is present EXACTLY when trust=provider_signed.
    if ("signature" in raw) {
        if (trust !== "provider_signed") {
            throw new Error(`${label}: signature is only permitted on provider_signed receipts`);
        }
        if (typeof raw.signature !== "string" || raw.signature.length < 1 || raw.signature.length > 4096) {
            throw new Error(`${label}: signature must be a 1..4096 char string (got ${typeName(raw.signature)})`);
        }
        receipt.signature = raw.signature;
    }
    else if (trust === "provider_signed") {
        throw new Error(`${label}: provider_signed receipt requires a signature`);
    }
    return receipt;
}
