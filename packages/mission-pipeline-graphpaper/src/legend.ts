import type { DiagramLegendEntry, DiagramRenderOptions } from "graphpaper";
import { frozenData } from "./validation.js";

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
