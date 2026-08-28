import { type ValidationDataLimits } from "../internal/evidence.js";
export declare const MAX_GRAPH_VALIDATION_DEPTH = 16;
export declare const MAX_GRAPH_VALIDATION_VALUES = 50000;
export declare const MAX_GRAPH_VALIDATION_STRING_CODE_UNITS = 2097152;
export declare const GRAPH_VALIDATION_LIMITS: ValidationDataLimits;
/** Descriptor-safe, detached validation snapshot under the N1 aggregate cap. */
export declare function snapshotGraphValidationData<T>(value: T, label: string): T;
