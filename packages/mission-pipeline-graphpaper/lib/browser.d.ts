import { type DiagramLayoutEngine, type DiagramModel, type DiagramNode } from "graphpaper";
import type { NodeDetails } from "./viewer-types.js";
export interface PipelineViewerSelection {
    readonly nodeId: string | null;
    readonly node: DiagramNode | null;
    readonly source: string;
}
export interface MountPipelineViewerOptions {
    /** JSON text is the boundary for untrusted values; live objects are trusted carriers. */
    readonly model?: DiagramModel | string;
    readonly onSelect?: (selection: PipelineViewerSelection) => void;
    /** Consumer-authorized read. The viewer has no fetch or route of its own. */
    readonly details?: (nodeId: string) => Promise<NodeDetails | string | undefined>;
    readonly deepLink?: {
        readonly param?: string;
    } | false;
    readonly legendVisible?: boolean;
    readonly layoutEngine?: DiagramLayoutEngine;
}
export interface PipelineViewerHandle {
    /** Unknown IDs, and calls after destroy, return false without changing selection. */
    select(nodeId: string | null): boolean;
    /** Remove owned interactions/panel and restore the original server-rendered children. */
    destroy(): void;
}
/**
 * Hydrate one static pipeline figure, optionally wiring selection to an
 * authorized details provider. Browser objects and callbacks are trusted;
 * ordinary accessors are refused, but JavaScript cannot detect live Proxies.
 */
export declare function mountPipelineViewer(container: Element, options?: MountPipelineViewerOptions): Promise<PipelineViewerHandle>;
