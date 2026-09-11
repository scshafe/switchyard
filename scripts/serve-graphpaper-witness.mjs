// Private local browser witness: built SDK, real ELK, and canned fixture details.
// Run after the normal build: node scripts/serve-graphpaper-witness.mjs
import { createServer } from "node:http";
import { registerHooks } from "node:module";

// The separate SDK package is not installed into this repository's node_modules.
// Resolve its engine peer to this checkout's built public modules for this process.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@scshafe/switchyard") return { url: new URL("../lib/index.js", import.meta.url).href, shortCircuit: true };
    if (specifier.startsWith("@scshafe/switchyard/")) {
      return { url: new URL(`../lib/${specifier.slice("@scshafe/switchyard/".length)}.js`, import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
const [engine, sdk, serverSdk, fixture, { default: ELK }] = await Promise.all([
  import("../lib/index.js"),
  import("../packages/mission-pipeline-graphpaper/lib/index.js"),
  import("../packages/mission-pipeline-graphpaper/lib/server.js"),
  import("../test/fixtures/switchyard/support-triage-example.mjs"),
  import("elkjs/lib/elk.bundled.js")
]);
const { SUPPORT_TRIAGE_GRAPH: graph, SUPPORT_TRIAGE_PRESENTATION: words, SUPPORT_TRIAGE_GOAL_MANIFEST: goalManifest } = fixture;
const projection = engine.projectGraphDisplay(engine.compileGraph(graph));
const model = sdk.buildPipelineDiagram({
  projection, definition: graph, goalManifest,
  presentation: { ...words, schemaVersion: sdk.PIPELINE_PRESENTATION_SCHEMA_VERSION }
});
const figure = await serverSdk.renderPipelineFigure(model, {
  layoutEngine: new ELK(), figureId: "support-triage-figure", modelElementId: "support-triage-model"
});
const assets = serverSdk.viewerAssets();
const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node]));
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Static graphpaper browser witness</title>
<link rel="stylesheet" href="/assets/diagram.css"><link rel="stylesheet" href="/assets/pipeline.css">
<style>body{margin:0;padding:24px;font:16px/1.5 system-ui,sans-serif;color:#172033;background:#f8fafc}
main{max-width:1200px;margin:auto}h1{font-size:24px}nav{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
button,label{font:inherit}button{padding:8px 12px;cursor:pointer}label{display:inline-flex;align-items:center;gap:6px}
.status{display:block;margin:8px 0;padding:8px;background:#e2e8f0}pre.status{white-space:pre-wrap;overflow-wrap:anywhere}.figure-host{background:white;padding:12px;border:1px solid #cbd5e1}
@media(max-width:680px){body{padding:12px}.figure-host{padding:4px}}</style>
<script src="/assets/elk.js" defer></script><script type="module" src="/witness.js"></script></head>
<body><main><h1>Support triage: static browser witness</h1>
<p>This page uses the sealed fixture graph, real ELK, and canned local details. It makes no provider calls and executes no pipeline turns.</p>
<p>Use Tab and Enter/Space to select a node, Escape to close its panel, and the diagram controls to zoom. Resize below 680 px to inspect the bottom sheet.</p>
<nav aria-label="Witness controls"><button id="select-normalize">Select normalizer</button><button id="select-model">Select outage signal</button>
<button id="clear">Clear selection</button><button id="destroy">Destroy viewer</button><button id="remount">Remount viewer</button></nav>
<nav aria-label="Details scenarios"><label><input id="wrong-identity" type="checkbox">Return wrong graph identity</label>
<label><input id="slow-details" type="checkbox">Delay details by 650 ms</label></nav>
<nav aria-label="Deterministic details races"><button id="race-nodes">Race slow normalizer / fast signal</button>
<button id="race-identity">Race stale same-node identity</button><button id="destroy-pending">Destroy with pending details</button>
<button id="remount-pending">Remount with pending details</button></nav>
<output id="viewer-status" class="status" aria-live="polite">Server figure ready; waiting for hydration.</output>
<output id="selection-status" class="status" aria-live="polite">Selection: none</output>
<output id="motion-status" class="status">Motion preference: checking</output>
<pre id="details-events" class="status" aria-label="Details request log">No details requests.</pre>
<div class="figure-host">${figure}</div>
</main></body></html>`;
const browserScript = `import { mountPipelineViewer } from "/assets/viewer.js";
const get = (id) => document.getElementById(id);
const status = get("viewer-status");
let viewer;
let mounting = false;
let selected = null;
let requestId = 0;
const events = [];
const logDetails = (message) => { events.push(message); get("details-events").textContent = events.slice(-6).join("\\n"); };
const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
const showMotion = () => { get("motion-status").textContent = "Motion preference: " + (motion.matches ? "reduced" : "no preference"); };
motion.addEventListener("change", showMotion);
showMotion();
async function mount() {
  if (mounting || viewer) { status.textContent = "Viewer already mounted or mounting."; return; }
  mounting = true;
  status.textContent = "Hydrating with real ELK…";
  try {
    viewer = await mountPipelineViewer(get("support-triage-figure"), {
      layoutEngine: new window.ELK(),
      details: async (nodeId) => {
        const id = ++requestId;
        const params = new URLSearchParams({ mismatch: get("wrong-identity").checked ? "1" : "0", delay: get("slow-details").checked ? "650" : "0" });
        const label = "#" + id + " " + nodeId + " " + params;
        logDetails("Started " + label);
        const response = await fetch("/details/" + encodeURIComponent(nodeId) + "?" + params);
        if (!response.ok) throw new Error("Local fixture details unavailable");
        const text = await response.text();
        logDetails("Received " + label);
        return text;
      },
      onSelect: (pick) => {
        selected = pick.nodeId;
        get("selection-status").textContent = "Selection: " + (selected ?? "none") + " · source: " + pick.source;
      }
    });
    status.textContent = "Viewer mounted with real ELK. Keyboard, deep links, details, and teardown are ready to inspect.";
  } catch (error) { status.textContent = "Mount failed; server figure retained: " + error.message; }
  finally { mounting = false; }
}
function select(nodeId) {
  if (!viewer) { status.textContent = "Viewer is not mounted. Use Remount viewer."; return; }
  if (!viewer.select(nodeId)) status.textContent = "Selection was refused.";
}
get("select-normalize").addEventListener("click", () => select("normalize"));
get("select-model").addEventListener("click", () => select("outage-signal"));
get("clear").addEventListener("click", () => select(null));
function destroy() {
  if (!viewer) { status.textContent = "Viewer is not mounted."; return; }
  viewer.destroy(); viewer = undefined; selected = null;
  get("selection-status").textContent = "Selection: none";
  status.textContent = "Viewer destroyed; original server figure restored. Use Remount viewer.";
}
get("destroy").addEventListener("click", destroy);
get("remount").addEventListener("click", () => { void mount(); });
get("wrong-identity").addEventListener("change", () => {
  if (!viewer) return;
  const again = selected ?? "outage-signal";
  viewer.select(null); viewer.select(again);
});
function beginDelayed(mismatch = false) {
  if (!viewer) { status.textContent = "Viewer is not mounted. Use Remount viewer."; return false; }
  get("wrong-identity").checked = mismatch;
  get("slow-details").checked = true;
  viewer.select(null); viewer.select("normalize");
  get("wrong-identity").checked = false;
  get("slow-details").checked = false;
  return true;
}
get("race-nodes").addEventListener("click", () => {
  if (beginDelayed()) viewer.select("outage-signal");
});
get("race-identity").addEventListener("click", () => {
  if (beginDelayed(true)) { viewer.select(null); viewer.select("normalize"); }
});
get("destroy-pending").addEventListener("click", () => {
  if (beginDelayed()) destroy();
});
get("remount-pending").addEventListener("click", () => {
  if (beginDelayed(true)) { destroy(); void mount(); }
});
if (document.readyState === "complete") void mount();
else window.addEventListener("load", () => { void mount(); }, { once: true });
`;
const server = createServer((request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const send = (status, type, body) => {
    response.writeHead(status, { "Content-Type": type });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  if (request.method !== "GET" && request.method !== "HEAD") return send(405, "text/plain; charset=utf-8", "GET or HEAD only");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/") return send(200, "text/html; charset=utf-8", page);
  if (url.pathname === "/witness.js") return send(200, "text/javascript; charset=utf-8", browserScript);
  if (url.pathname.startsWith("/assets/")) {
    const asset = assets[url.pathname.slice("/assets/".length)];
    if (asset) { response.setHeader("ETag", asset.etag); return send(200, asset.contentType, asset.body); }
  }
  if (url.pathname.startsWith("/details/")) {
    let nodeId;
    try { nodeId = decodeURIComponent(url.pathname.slice("/details/".length)); }
    catch { return send(400, "text/plain; charset=utf-8", "Malformed node ID"); }
    const node = nodeById.get(nodeId);
    if (node) {
      const details = {
        graph: { ...projection.graph, ...(url.searchParams.get("mismatch") === "1" ? { version: projection.graph.version + 1 } : {}) },
        nodeId, sealed: { ref: node.ref, kind: node.kind, input: node.input, outcomes: node.outcomes.outcomes,
          maxAttempts: node.turn.maxAttempts, leaseMs: node.turn.leaseMs, ...(node.binding ? { binding: node.binding } : {}) },
        ...(node.outputs ? { outputs: Object.entries(node.outputs).map(([outcome, contractId]) => ({ outcome, contractId })) } : {}),
        ...(words.nodes[nodeId].question ? { question: words.nodes[nodeId].question } : {})
      };
      const deliver = () => send(200, "application/json; charset=utf-8", JSON.stringify(details));
      return url.searchParams.get("delay") === "650" ? void setTimeout(deliver, 650) : deliver();
    }
  }
  return send(404, "text/plain; charset=utf-8", "Not found");
});
server.listen(0, "127.0.0.1", () => {
  console.log(`Graphpaper browser witness: http://127.0.0.1:${server.address().port}/`);
  console.log("Local fixture only. Stop with Ctrl-C; no files, stores, providers, or credentials are changed.");
});
