import type { DiagramLegendEntry, DiagramRenderOptions } from "graphpaper";
/** Static legend data. Execution, metrics, and proposal modes are not shipped. */
export declare function pipelineLegend(mode?: "static"): readonly DiagramLegendEntry[];
/** Layout defaults passed through to graphpaper, without a renderer or engine. */
export declare const PIPELINE_RENDER_OPTIONS: DiagramRenderOptions;
