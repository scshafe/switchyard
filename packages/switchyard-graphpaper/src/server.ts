import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { layoutDiagram, renderDiagramSvg, type DiagramLayout, type DiagramLayoutEngine, type DiagramModel, type DiagramRenderOptions } from "@scshafe/graphpaper";
import { captureCapabilityMethod, captureCapabilityRecord } from "@scshafe/switchyard/internal/capability";
import { deepFrozenClone, snapshotBoundedValidationData } from "@scshafe/switchyard/internal/evidence";
import { validateStaticLayoutResult, validateStaticModel } from "./viewer-data.js";
import { staticViewerRenderOptions } from "./viewer-defaults.js";

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

const DATA_LIMITS = Object.freeze({ maxDepth: 24, maxValues: 1_000_000, maxStringCodeUnits: 33_554_432 });
const MAX_LAYOUT_PIXELS = 1_000_000;

function snapshot<T>(value: T, label: string): T {
  return deepFrozenClone(snapshotBoundedValidationData(value, label, DATA_LIMITS), label);
}

function elementId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 200 || !/^[a-z0-9][a-z0-9._:~\-]*$/i.test(value)) {
    throw new Error(`${label} must be a bounded element ID containing letters, digits, '.', '_', ':', '~', or '-'`);
  }
  return value;
}

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
}

function inertJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function assertLayout(layout: DiagramLayout, model: DiagramModel): void {
  const validNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_LAYOUT_PIXELS;
  if (!validNumber(layout.width) || !validNumber(layout.height) || layout.width <= 0 || layout.height <= 0) {
    throw new Error("pipeline figure layout must have positive finite dimensions within 1000000 pixels");
  }
  if (layout.positions.size !== model.nodes.length || model.nodes.some((node) => !layout.positions.has(node.id))) {
    throw new Error("pipeline figure layout must cover every model node");
  }
  for (const position of layout.positions.values()) {
    if (![position.x, position.y, position.width, position.height, position.centerX, position.centerY].every(validNumber) || position.width <= 0 || position.height <= 0) {
      throw new Error("pipeline figure layout contains invalid node geometry");
    }
  }
  for (const box of layout.edgeLabelBoxes?.values() ?? []) {
    if (![box.x, box.y, box.width, box.height].every(validNumber) || box.width < 0 || box.height < 0) {
      throw new Error("pipeline figure layout contains invalid label geometry");
    }
  }
}

/**
 * Render one static model as SVG plus inert model JSON. The caller serves its
 * own scripts and styles; this function inserts no executable asset loaders.
 * graphpaper's built-in layout is available when no engine is supplied, and
 * its ordinary fallback remains available if an injected engine fails.
 */
export async function renderPipelineFigure(model: DiagramModel, options: RenderPipelineFigureOptions = {}): Promise<string> {
  const fields = captureCapabilityRecord(options, ["layoutEngine", "figureId", "modelElementId"], [], "pipeline figure options");
  const safeModel = validateStaticModel(snapshot(model, "pipeline figure model"));
  const figureId = elementId(Object.hasOwn(fields, "figureId") ? fields.figureId : `${safeModel.id}-figure`, "figureId");
  const modelElementId = Object.hasOwn(fields, "modelElementId")
    ? elementId(fields.modelElementId, "modelElementId")
    : `${figureId}-model`;
  if (figureId === modelElementId) throw new Error("figureId and modelElementId must differ");
  let layoutEngine: DiagramLayoutEngine | undefined;
  if (Object.hasOwn(fields, "layoutEngine")) {
    const layout = captureCapabilityMethod(fields.layoutEngine, "layout", "pipeline figure layout engine");
    layoutEngine = Object.freeze({
      layout: async (graph: unknown) => {
        try {
          return validateStaticLayoutResult(snapshot(await layout(graph), "pipeline figure layout result"), safeModel.nodes.map((node) => node.id));
        } catch {
          // graphpaper logs layout failures before falling back. Never pass a
          // caller-owned thrown object to its logger or custom inspect hooks.
          throw new Error("pipeline figure layout engine failed or returned invalid data");
        }
      }
    });
  }
  const markerId = `pipeline-arrow-${createHash("sha256").update(figureId).digest("hex").slice(0, 16)}`;
  const renderOptions: DiagramRenderOptions = {
    ...staticViewerRenderOptions(safeModel),
    markerId,
    ...(layoutEngine === undefined ? {} : { layoutEngine })
  };
  const layout = await layoutDiagram(safeModel, renderOptions);
  assertLayout(layout, safeModel);
  const markup = renderDiagramSvg(safeModel, layout, renderOptions);
  const size = `--pipeline-diagram-width:${Math.ceil(layout.width)}px;--pipeline-diagram-height:${Math.ceil(layout.height)}px`;
  return `<figure class="pipeline-viewer pipeline-diagram" id="${attribute(figureId)}" data-pipeline-viewer data-diagram-id="${attribute(safeModel.id)}" style="${size}"><div class="graphpaper" data-pipeline-canvas>${markup}</div><script type="application/json" data-pipeline-model id="${attribute(modelElementId)}">${inertJson(safeModel)}</script></figure>`;
}

let cachedAssets: Readonly<Record<string, PipelineViewerAsset>> | undefined;

/**
 * Read the installed viewer's fixed asset set. The host decides authorized
 * routes, cache headers, and CSP. Nothing is fetched or served by this helper.
 * ELK is required for this complete asset set, but not for fallback SSR.
 */
export function viewerAssets(): Readonly<Record<string, PipelineViewerAsset>> {
  if (cachedAssets !== undefined) return cachedAssets;
  const require = createRequire(import.meta.url);
  const ownFile = (name: string) => new URL(name, import.meta.url);
  const files = [
    { name: "viewer.js", source: () => ownFile("./browser.js"), owner: "built SDK browser module" },
    { name: "viewer-data.js", source: () => ownFile("./viewer-data.js"), owner: "built SDK viewer validator" },
    { name: "viewer-defaults.js", source: () => ownFile("./viewer-defaults.js"), owner: "built SDK viewer defaults" },
    { name: "types.js", source: () => ownFile("./types.js"), owner: "built SDK schema constants" },
    { name: "graphpaper.js", source: () => require.resolve("@scshafe/graphpaper"), owner: "installed @scshafe/graphpaper peer" },
    { name: "diagram.css", source: () => require.resolve("@scshafe/graphpaper/diagram.css"), owner: "installed @scshafe/graphpaper peer" },
    { name: "pipeline.css", source: () => ownFile("../assets/pipeline.css"), owner: "installed SDK stylesheet" },
    { name: "elk.js", source: () => require.resolve("elkjs/lib/elk.bundled.js"), owner: "installed elkjs peer" }
  ];
  const assets = Object.create(null) as Record<string, PipelineViewerAsset>;
  for (const file of files) {
    let body: string;
    try {
      body = readFileSync(file.source(), "utf8");
    } catch {
      throw new Error(`viewerAssets cannot read ${file.name}; provide the ${file.owner}`);
    }
    if (file.name === "viewer.js") {
      const specifier = 'from "@scshafe/graphpaper"';
      if (body.split(specifier).length !== 2) throw new Error("viewerAssets browser module must contain exactly one graphpaper import");
      body = body.replace(specifier, 'from "./graphpaper.js"');
    }
    const asset = Object.assign(Object.create(null), {
      contentType: file.name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
      body,
      etag: `"${createHash("sha256").update(body, "utf8").digest("hex")}"`
    }) as PipelineViewerAsset;
    assets[file.name] = Object.freeze(asset);
  }
  cachedAssets = Object.freeze(assets);
  return cachedAssets;
}
