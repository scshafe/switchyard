// graph/limits.ts — aggregate hostile-input bounds shared by every N1 validator.
import { snapshotBoundedValidationData } from "../internal/evidence.js";
export const MAX_GRAPH_VALIDATION_DEPTH = 16;
export const MAX_GRAPH_VALIDATION_VALUES = 50_000;
export const MAX_GRAPH_VALIDATION_STRING_CODE_UNITS = 2_097_152;
export const GRAPH_VALIDATION_LIMITS = Object.freeze({
    maxDepth: MAX_GRAPH_VALIDATION_DEPTH,
    maxValues: MAX_GRAPH_VALIDATION_VALUES,
    maxStringCodeUnits: MAX_GRAPH_VALIDATION_STRING_CODE_UNITS
});
/** Descriptor-safe, detached validation snapshot under the N1 aggregate cap. */
export function snapshotGraphValidationData(value, label) {
    return snapshotBoundedValidationData(value, label, GRAPH_VALIDATION_LIMITS);
}
