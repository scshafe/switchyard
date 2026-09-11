import type { DiagramLegendEntry, DiagramModel, DiagramRenderOptions } from "graphpaper";
import { snapshotViewerData as frozenData } from "./viewer-data.js";

const STATIC_LEGEND: readonly DiagramLegendEntry[] = frozenData([
  { type: "code", label: "Code" },
  { type: "model", label: "Model" },
  { type: "human", label: "Human review" },
  { type: "agent", label: "Agent" },
  { type: "callback", label: "Callback" },
  { type: "endpoint", label: "Endpoint: a result leaves the graph" },
  { type: "terminal", label: "Quiet end" },
  { edge: { kind: "outcome" }, label: "Outcome" },
  { edge: { kind: "join" }, label: "Join input" },
  { edge: { kind: "exit" }, label: "Exit or presented wait" }
]);

/** Static legend data. Execution, metrics, and proposal modes are not shipped. */
export function pipelineLegend(mode: "static" = "static"): readonly DiagramLegendEntry[] {
  if (mode !== "static") throw new Error("pipeline legend mode must be static");
  return STATIC_LEGEND;
}

/** Layout defaults passed through to graphpaper, without a renderer or engine. */
export const PIPELINE_RENDER_OPTIONS: DiagramRenderOptions = frozenData({
  direction: "DOWN",
  compact: true,
  stereotypes: false,
  legendTitle: "Key",
  showEdgeLabels: true,
  edgeLabelPlacement: "tail",
  nodeWidth: 190,
  popoverHoverDelayMs: 300,
  panZoom: true,
  sourceLabel: "graphpaper · ELK",
  elkUnavailableSourceLabel: "graphpaper · built-in layered layout (ELK unavailable)",
  elkErrorSourceLabel: "graphpaper · built-in layered layout (ELK failed)",
  fallbackSourceLabel: "graphpaper · built-in layered layout"
});

/** Internal adapter options: never accept executable options through inheritance. */
export function staticViewerRenderOptions(model: DiagramModel): DiagramRenderOptions {
  // graphpaper normalizes options through object spread. Own undefined keys
  // survive that copy and select its defaults without reading ambient getters.
  const options: DiagramRenderOptions = Object.create(null);
  for (const key of [
    "direction", "edgeRouting", "hierarchy", "hierarchyEdgeTypes", "compact",
    "showPopovers", "popoverHoverDelayMs", "visibleRows", "showEdgeLabels",
    "edgeLabelPlacement", "stereotypes", "legend", "legendTitle", "legendVisible",
    "minWidth", "minHeight", "title", "sourceLabel", "fallbackSourceLabel",
    "elkErrorSourceLabel", "elkUnavailableSourceLabel", "ariaLabel", "caption",
    "markerId", "diagramId", "nodeWidth", "nodeHeight", "layoutEngine",
    "drawHierarchyEdgesWhenNested", "panZoom", "panZoomControls", "minScale",
    "maxScale", "zoomStep", "drillDown", "resolveScope", "hasScope", "onScopeChange",
    "scopeExitOnBackground", "scopeBreadcrumb", "scopeTransition", "stageControls",
    "initialStage", "onStageChange", "onNodeSelect", "nodeRenderers"
  ]) options[key] = undefined;
  const renderers = Object.create(null) as NonNullable<DiagramRenderOptions["nodeRenderers"]>;
  for (const kind of ["code", "model", "human", "agent", "callback", "endpoint", "terminal", "custom"]) {
    Object.defineProperty(renderers, kind, { value: undefined, enumerable: true });
  }
  return Object.assign(options, PIPELINE_RENDER_OPTIONS, {
    title: model.title, legend: pipelineLegend("static"), drillDown: false,
    scopeTransition: "crisp", stageControls: false, nodeRenderers: Object.freeze(renderers)
  });
}
