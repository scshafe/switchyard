import type { DiagramModel, DiagramModelInput } from "graphpaper";
import type { GraphDefinitionRef } from "mission-pipeline";
import type { NodeDetails } from "./viewer-types.js";
type Data = Readonly<Record<string, unknown>>;
/**
 * Browser capability capture. Live objects are trusted host inputs: browsers
 * cannot detect Proxies, so reflection may run their traps. For untrusted
 * model/details data, accept JSON text and parse it inside this module instead.
 * The Node adapter first uses the engine's Proxy-safe snapshot helpers.
 */
export declare function captureViewerRecord(value: unknown, allowed: readonly string[], required: readonly string[], label: string): Data;
/** Descriptor-only, bounded JSON snapshot for trusted browser objects/parsed JSON. */
export declare function snapshotViewerData<T>(value: T, label?: string): T;
/** Static SDK models only, not arbitrary graphpaper models or execution evidence. */
export declare function validateStaticModel(value: unknown): DiagramModel & DiagramModelInput;
/** Flat injected-layout data. Node callers must reject Proxies before this boundary. */
export declare function validateStaticLayoutResult(value: unknown, expectedNodeIds: readonly string[]): unknown;
/** Validate bounded provider data for one exact picked structural node. */
export declare function validateNodeDetails(value: unknown, expectedGraph: GraphDefinitionRef, expectedNodeId: string): NodeDetails;
export {};
