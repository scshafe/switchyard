/** Grammar of a contract id: `<name>.v<number>` (frozen $defs.contractId). */
export declare const CONTRACT_ID_PATTERN: RegExp;
export declare const CONTRACT_ID_MIN_LENGTH = 1;
export declare const CONTRACT_ID_MAX_LENGTH = 160;
/** Bare lowercase sha256 hex — NO `sha256:` prefix (frozen $defs.sha256). */
export declare const SHA256_HEX_PATTERN: RegExp;
/** A validated `<name>.v<number>` contract id, e.g. `email-normalized.v1`. */
export type ContractId = string;
export interface ParsedContractId {
    /** Everything before the final `.v<number>` suffix, e.g. `email-normalized`. */
    name: string;
    /** The positive integer version, e.g. 1 for `….v1`. */
    version: number;
}
export declare function isContractId(value: unknown): value is ContractId;
/**
 * LOUD parse of the ContractId grammar. Returns `{ name, version }` (splitting
 * on the FINAL `.v<digits>` suffix — the name part may itself contain dots) or
 * throws with a precise message.
 */
export declare function parseContractId(value: unknown): ParsedContractId;
/** LOUD assertion form of {@link isContractId} (labels the failing field). */
export declare function validateContractId(value: unknown, label?: string): ContractId;
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
/**
 * Descriptor-safe detachment under the artifact contract's hostile-data
 * budget. Semantic envelope validation remains the caller's next step.
 */
export declare function snapshotArtifactValidationData<T>(value: T, label: string): T;
/**
 * LOUD guard for one bounded strict JSON value. Validation is descriptor-safe:
 * accessors and Proxies are rejected without executing caller code.
 */
export declare function assertJsonValue(value: unknown, path?: string): void;
/** LOUD validator for the frozen `artifact-ref.v1` shape. Returns the ref. */
export declare function validateArtifactRef(value: unknown): ArtifactRef;
/**
 * LOUD validator for a digest-sealed {@link ArtifactEnvelope}. Beyond the shape
 * checks it RE-COMPUTES the payload digest (and canonical byte length, when
 * `bytes` is present) and throws "digest mismatch" on any disagreement — the
 * same fail-closed sealing semantics as the inbox runtime contracts'
 * `superRefine` digest checks.
 */
export declare function validateArtifactEnvelope(value: unknown): ArtifactEnvelope;
/**
 * Seal a payload into an {@link ArtifactEnvelope} (the promoted `create*`
 * pattern: validate inputs, compute the canonical digest, return the sealed
 * record — always with `bytes` filled in, since the canonical form is at hand).
 */
export declare function createArtifactEnvelope(contractId: ContractId, payload: unknown): ArtifactEnvelope;
/** Project the content-addressed {@link ArtifactRef} out of a sealed envelope. */
export declare function artifactRef(envelopeRaw: ArtifactEnvelope): ArtifactRef;
