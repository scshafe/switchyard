import { type GraphDisplayProjection } from "mission-pipeline/graph/display";
import { type TerminalOutcome } from "mission-pipeline/graph/definition";
import { type PipelinePresentation, type PresentationValidationOptions } from "./types.js";
/** Internal: callers must budget unknown input before cloning it recursively. */
export declare function frozenData<T>(value: T): T;
/**
 * Return coverage diagnostics; malformed or hostile data throws. Unclaimed
 * terminals are diagnostics, but buildPipelineDiagram draws explicit fallbacks.
 * Without options.definition this checks shape/coverage, not source authenticity.
 */
export declare function validatePresentation(projection: GraphDisplayProjection, presentation: PipelinePresentation, options?: PresentationValidationOptions): readonly string[];
/** Internal descriptor-safe admission; no caller field is read before capture. */
export declare function prepareDiagramInput(value: unknown): {
    historical: boolean;
    projection: GraphDisplayProjection;
    presentation: PipelinePresentation;
    problems: string[];
    unclaimed: TerminalOutcome[];
    presentationDigest: string;
};
