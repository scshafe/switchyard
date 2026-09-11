import type { DiagramLegendEntry, DiagramModel, DiagramRenderOptions } from "graphpaper";
/** Static legend data. Execution, metrics, and proposal modes are not shipped. */
export declare function pipelineLegend(mode?: "static"): readonly DiagramLegendEntry[];
/** Layout defaults passed through to graphpaper, without a renderer or engine. */
export declare const PIPELINE_RENDER_OPTIONS: DiagramRenderOptions;
/** Internal adapter options: never accept executable options through inheritance. */
export declare function staticViewerRenderOptions(model: DiagramModel): DiagramRenderOptions;
