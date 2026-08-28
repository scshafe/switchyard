export declare const MAX_NODE_OUTCOMES = 64;
export interface OutcomeVocabulary {
    readonly version: number;
    readonly outcomes: readonly string[];
}
/** Validate, detach, and freeze a node's closed outcome vocabulary. */
export declare function validateOutcomeVocabulary(value: unknown, label?: string): OutcomeVocabulary;
