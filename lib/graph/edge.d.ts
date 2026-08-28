export declare const MAX_EDGE_TARGETS = 64;
export declare const MAX_FIELD_MATCHES = 32;
export declare const MAX_JSON_POINTER_LENGTH = 1024;
export declare const MAX_JSON_POINTER_TOKENS = 64;
export declare const MAX_EDGE_SCALAR_STRING_LENGTH = 16384;
export type JsonScalar = string | number | boolean | null;
export interface FieldMatch {
    readonly pointer: string;
    readonly equals: JsonScalar;
}
export type OutcomePredicate = {
    readonly outcome: string;
} | {
    readonly anyOf: readonly string[];
} | {
    readonly outcome: string;
    readonly where: readonly FieldMatch[];
};
export interface Edge {
    /** Stable author-supplied identity used by durable join bookkeeping. */
    readonly edgeId: string;
    readonly from: string;
    readonly when: OutcomePredicate;
    readonly to: readonly string[];
}
/** RFC 6901 JSON Pointer syntax, including the valid empty root pointer. */
export declare function validateJsonPointer(value: unknown, label?: string): string;
/** Strict JSON scalar validator used by FieldMatch.equals. */
export declare function validateJsonScalar(value: unknown, label?: string): JsonScalar;
/** Validate one arm of the closed v2 predicate language. */
export declare function validateOutcomePredicate(value: unknown, label?: string): OutcomePredicate;
/** Outcomes mentioned by a predicate, in authored order. */
export declare function predicateOutcomes(predicate: OutcomePredicate): readonly string[];
/** Conditional where-arms are additive and do not prove total coverage. */
export declare function isUnconditionalOutcomePredicate(predicate: OutcomePredicate): boolean;
/** Validate, detach, and freeze one graph edge. */
export declare function validateEdge(value: unknown, label?: string): Edge;
