import type { DiagramModel } from "graphpaper";
import { type BuildPipelineDiagramInput } from "./types.js";
/**
 * Build a static, immutable graphpaper model. Structure comes from the engine;
 * presentation words and any external wait connections come from the caller.
 * No runtime execution, delivery, or readiness state is inferred here.
 */
export declare function buildPipelineDiagram(input: BuildPipelineDiagramInput): DiagramModel;
