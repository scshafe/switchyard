import { type GraphDefinition, type GraphDefinitionRef } from "../graph/definition.js";
import { type GraphStore } from "./graph-store.js";
/**
 * Memory GraphStore used as the N3 conformance oracle. Methods contain no
 * awaits after validation, so graph evidence and the node-signature registry
 * become visible together or not at all.
 */
export declare class MemoryGraphStore implements GraphStore {
    #private;
    publishGraph(graphRaw: GraphDefinition): Promise<void>;
    loadGraph(refRaw: GraphDefinitionRef): Promise<GraphDefinition | undefined>;
}
