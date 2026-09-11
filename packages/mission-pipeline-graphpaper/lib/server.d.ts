import { type DiagramLayoutEngine, type DiagramModel } from "graphpaper";
export interface RenderPipelineFigureOptions {
    readonly layoutEngine?: DiagramLayoutEngine;
    readonly figureId?: string;
    readonly modelElementId?: string;
}
export interface PipelineViewerAsset {
    readonly contentType: string;
    readonly body: string;
    /** A quoted SHA-256 entity tag for the exact served UTF-8 bytes. */
    readonly etag: string;
}
/**
 * Render one static model as SVG plus inert model JSON. The caller serves its
 * own scripts and styles; this function inserts no executable asset loaders.
 * graphpaper's built-in layout is available when no engine is supplied, and
 * its ordinary fallback remains available if an injected engine fails.
 */
export declare function renderPipelineFigure(model: DiagramModel, options?: RenderPipelineFigureOptions): Promise<string>;
/**
 * Read the installed viewer's fixed asset set. The host decides authorized
 * routes, cache headers, and CSP. Nothing is fetched or served by this helper.
 * ELK is required for this complete asset set, but not for fallback SSR.
 */
export declare function viewerAssets(): Readonly<Record<string, PipelineViewerAsset>>;
