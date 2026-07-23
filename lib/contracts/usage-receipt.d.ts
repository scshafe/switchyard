export declare const USAGE_RECEIPT_SCHEMA_VERSION = "usage-receipt.v1";
/** The frozen trust tiers, in descending trust order. */
export declare const USAGE_TRUST_TIERS: readonly ["provider_signed", "provider_reported", "estimated_tier_ceiling", "unavailable"];
export type UsageTrust = (typeof USAGE_TRUST_TIERS)[number];
/** The FROZEN `usage-receipt.v1` numeric bounds (source of truth: the schema mirror). */
export declare const USAGE_RECEIPT_BOUNDS: Readonly<{
    maxChargedTokens: 10000000;
    maxChargedCostMicroUsd: 100000000000;
    maxDurationMs: 86400000;
}>;
export declare const USAGE_ROUTE_ALIAS_PATTERN: RegExp;
/**
 * The config-pinned floor for a receipt with no telemetry and no tier ceiling
 * (promoted UNAVAILABLE_USAGE_FLOOR). A policy value, never an observation.
 */
export declare const UNAVAILABLE_USAGE_FLOOR: Readonly<{
    chargedTokens: 1;
    chargedCostMicroUsd: 1;
}>;
/** The frozen usage-receipt.v1 runtime shape. */
export interface UsageReceipt {
    schemaVersion: typeof USAGE_RECEIPT_SCHEMA_VERSION;
    trust: UsageTrust;
    observedInputTokens: number | null;
    observedOutputTokens: number | null;
    chargedTokens: number;
    observedCostMicroUsd: number | null;
    chargedCostMicroUsd: number;
    durationMs: number;
    routeAlias?: string;
    signature?: string;
}
/**
 * LOUD validator for a frozen `usage-receipt.v1` payload: full shape + the
 * trust-tier `allOf` rules + the CODE-SIDE floor and charged-covers-observed
 * rules (see the module header). Returns a fresh normalized receipt or throws
 * with a precise message.
 */
export declare function validateUsageReceipt(value: unknown): UsageReceipt;
