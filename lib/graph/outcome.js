// graph/outcome.ts — the strict, versioned return vocabulary of one v2 node.
//
// Outcome names are routing data, not free-form provider output. A vocabulary
// is non-empty and unique, and its version is required to match the node
// definition ref that owns it (the graph definition validator enforces that
// cross-field invariant). Changing the vocabulary therefore requires a new
// node version, per DESIGN §10.5.
import { assertIdentifier, assertPlainObject, assertRequiredKeys, assertSafePositiveInt, assertStrictKeys, typeName } from "../internal/guards.js";
import { deepFrozenClone } from "../internal/evidence.js";
import { snapshotGraphValidationData } from "./limits.js";
export const MAX_NODE_OUTCOMES = 64;
const OUTCOME_VOCABULARY_KEYS = new Set(["version", "outcomes"]);
/** Validate, detach, and freeze a node's closed outcome vocabulary. */
export function validateOutcomeVocabulary(value, label = "outcome vocabulary") {
    value = snapshotGraphValidationData(value, label);
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, OUTCOME_VOCABULARY_KEYS, label);
    assertRequiredKeys(raw, OUTCOME_VOCABULARY_KEYS, label);
    const version = assertSafePositiveInt(raw.version, `${label}: version`);
    if (!Array.isArray(raw.outcomes)
        || raw.outcomes.length < 1
        || raw.outcomes.length > MAX_NODE_OUTCOMES) {
        throw new Error(`${label}: outcomes must be an array of 1..${MAX_NODE_OUTCOMES} names (got ${Array.isArray(raw.outcomes) ? raw.outcomes.length : typeName(raw.outcomes)})`);
    }
    const outcomes = raw.outcomes.map((outcome, index) => assertIdentifier(outcome, `${label}: outcomes[${index}]`));
    if (new Set(outcomes).size !== outcomes.length) {
        throw new Error(`${label}: outcomes must be unique`);
    }
    return deepFrozenClone({ version, outcomes }, label);
}
