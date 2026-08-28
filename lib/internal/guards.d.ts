/**
 * The identifier grammar shared by stage ids, node ids, slot names, pipeline
 * ids, binding ids, and capability strings — promoted byte-identically from
 * inbox-pipeline's `IdentifierSchema` (`z.string().min(1).max(160).regex(…)`).
 * Note the grammar ALLOWS `:` (e.g. `network:model`), unlike the contract-id
 * grammar.
 */
export declare const IDENTIFIER_PATTERN: RegExp;
export declare const IDENTIFIER_MIN_LENGTH = 1;
export declare const IDENTIFIER_MAX_LENGTH = 160;
export declare function typeName(value: unknown): string;
export declare function truncate(s: string, max?: number): string;
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
export declare function assertPlainObject(value: unknown, label: string): Record<string, unknown>;
export declare function assertStrictKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void;
/** Required keys must be own data captured by the validation snapshot. */
export declare function assertRequiredKeys(value: Record<string, unknown>, required: ReadonlySet<string>, label: string): void;
export declare function assertIdentifier(value: unknown, label: string): string;
export declare function assertPositiveInt(value: unknown, label: string): number;
/** Identity/version integers must round-trip through JSON without aliasing. */
export declare function assertSafePositiveInt(value: unknown, label: string): number;
export declare function assertSha256Hex(value: unknown, label: string): string;
export declare function assertEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T;
/**
 * The shared content-addressed reference shape `{ id, version, digest }` used
 * by the B4 prompt refs (component/persona/prompt-stack) and model-binding
 * refs (model revision) — the promoted inbox `*RefSchema` shape.
 */
export interface VersionedDigestRef {
    id: string;
    version: number;
    digest: string;
}
/** LOUD validator for a {@link VersionedDigestRef}; returns a fresh normalized ref. */
export declare function assertVersionedRef(value: unknown, label: string): VersionedDigestRef;
