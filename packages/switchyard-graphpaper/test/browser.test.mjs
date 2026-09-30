// Isolate the SDK wiring with graphpaper's public selection/hydration seam.
// The packed renderer smoke and browser witness exercise the real renderer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { bindDiagramInteractions, clearDiagramNodeSelection as realClear, cleanupHydratedDiagram as realCleanup, layoutDiagram as realLayoutDiagram } from "graphpaper";

const state = { calls: [], selections: new WeakMap(), beforeHydrate: undefined, cleanups: 0 };
globalThis.__pipelineViewerGraphpaperTest = state;
const mockSource = `
const state=globalThis.__pipelineViewerGraphpaperTest;
export async function hydrateDiagram(container, model, options) {
  state.calls.push({container,model,options});
  if(state.beforeHydrate) await state.beforeHydrate(container);
  const svg=container.ownerDocument.createElement('svg');
  for(const node of model.nodes){const drawn=container.ownerDocument.createElement('g');drawn.setAttribute('data-diagram-node',node.id);svg.append(drawn);}
  container.replaceChildren(svg);
  state.selections.set(container,{model,options,current:null});
}
export function selectDiagramNode(container,id,{notify=true}={}) {
  const selected=state.selections.get(container); if(!selected)return false;
  const node=id===null?null:selected.model.nodes.find(node=>node.id===id);if(id!==null&&!node)return false;
  if(selected.current===id)return true;selected.current=id;
  if(notify)selected.options.onNodeSelect({nodeId:id,node,source:'api'});return true;
}
export function clearDiagramNodeSelection(container){return selectDiagramNode(container,null);}
export function cleanupHydratedDiagram(container){state.cleanups+=1;state.selections.delete(container);}
`;
const mockUrl = `data:text/javascript,${encodeURIComponent(mockSource)}`;
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === "graphpaper" ? { url: mockUrl, shortCircuit: true } : nextResolve(specifier, context);
} });
const { mountPipelineViewer } = await import("switchyard-graphpaper/browser");
hooks.deregister();
delete globalThis.__pipelineViewerGraphpaperTest;

class Events {
  listeners = new Map();
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) ?? new Set(); listeners.add(callback); this.listeners.set(name, listeners);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  fire(name, extra = {}) {
    const event = { target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    for (const callback of [...(this.listeners.get(name) ?? [])]) callback(event);
    return event;
  }
}

class Element extends Events {
  nodeType = 1;
  childNodes = [];
  parentElement = null;
  attributes = new Map();
  className = "";
  hidden = false;
  text = "";
  constructor(document, tag) { super(); this.ownerDocument = document; this.tagName = tag.toUpperCase(); }
  get parentNode() { return this.parentElement; }
  get isConnected() { return this === this.ownerDocument.body || this.parentElement?.isConnected === true; }
  get nextSibling() { return this.parentElement?.childNodes[this.parentElement.childNodes.indexOf(this) + 1] ?? null; }
  get classList() { return {
    contains: (value) => this.className.split(/\s+/u).includes(value),
    add: (value) => { if (!this.classList.contains(value)) this.className = [this.className, value].filter(Boolean).join(" "); },
    remove: (value) => { this.className = this.className.split(/\s+/u).filter((entry) => entry !== value).join(" "); }
  }; }
  get textContent() { return this.text + this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, before) {
    child.remove(); const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    assert.ok(index >= 0); this.childNodes.splice(index, 0, child); child.parentElement = this;
  }
  replaceChildren(...children) { for (const child of this.childNodes) child.parentElement = null; this.childNodes = []; this.text = ""; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.childNodes.splice(this.parentElement.childNodes.indexOf(this), 1); this.parentElement = null; }
  contains(child) { for (let item = child; item; item = item.parentElement) if (item === this) return true; return false; }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) {
    const match = (element) => {
      if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
      const tag = /^[a-z]+/u.exec(selector)?.[0];
      if (tag && element.tagName !== tag.toUpperCase()) return false;
      for (const [, key, expected] of selector.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/gu)) {
        if (!element.attributes.has(key) || expected !== undefined && element.getAttribute(key) !== expected) return false;
      }
      return true;
    };
    const found = [];
    const walk = (parent) => { for (const child of parent.childNodes) { if (match(child)) found.push(child); walk(child); } };
    walk(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const model = JSON.parse(readFileSync(new URL("./fixtures/support-triage.static.golden.json", import.meta.url), "utf8"));
const validLayout = () => ({ id: model.id, width: 300, height: model.nodes.length * 100,
  children: model.nodes.map((node, index) => ({ id: node.id, x: 0, y: index * 100, width: 190, height: 76 })), edges: [] });
function fixture(hash = "", existing) {
  let url = new URL(`https://example.test/pipeline?window=7d${hash}`);
  const window = existing?.window ?? new Events();
  if (!existing) {
    window.location = { get href() { return url.href; }, get hash() { return url.hash; }, set hash(value) { url.hash = value; } };
    window.history = { state: { page: "retained" }, writes: [], replaceState(value, unused, href) {
      this.state = value; this.writes.push(href); url = new URL(href);
    } };
  }
  const document = existing?.document ?? { defaultView: window, activeElement: null,
    createElement(tag) { return new Element(this, tag); } };
  if (!existing) document.body = document.createElement("body");
  const host = existing?.host ?? document.createElement("section");
  if (!existing) document.body.append(host);
  const container = document.createElement("figure");
  const canvas = document.createElement("div"); canvas.setAttribute("data-pipeline-canvas", "");
  const original = document.createElement("svg"); original.setAttribute("data-ssr", "original");
  canvas.append(original);
  const script = document.createElement("script"); script.setAttribute("type", "application/json"); script.setAttribute("data-pipeline-model", ""); script.textContent = JSON.stringify(model);
  container.append(canvas, script); host.append(container);
  return { window, document, host, container, canvas, script, original };
}

function details(nodeId, question = `Details for ${nodeId}`) {
  const kind = model.nodes.find((node) => node.id === nodeId)?.type ?? "code";
  return { graph: model.metadata.pipeline.graph, nodeId, question,
    sealed: { ref: { id: `fixture.${nodeId}`, version: 1 }, kind, input: "fixture.v1", outcomes: ["done"], maxAttempts: 3, leaseMs: 30000,
      ...(kind === "model" ? { binding: { kind: "model", bindingId: "fixture.binding", version: 1, bindingDigest: "a".repeat(64) } } : {}) } };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function keyboardPick(canvas, nodeId, suppliedNode) {
  const current = state.selections.get(canvas); current.current = nodeId;
  current.options.onNodeSelect({ nodeId, node: suppliedNode ?? current.model.nodes.find((node) => node.id === nodeId), source: "keyboard" });
}

test("embedded hydration keeps inert model JSON and gives a frozen static-only handle", async () => {
  const view = fixture();
  const handle = await mountPipelineViewer(view.container, { legendVisible: false });
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(Object.getPrototypeOf(handle), null);
  assert.deepEqual(Object.keys(handle).sort(), ["destroy", "select"]);
  assert.equal(view.container.querySelector("script[data-pipeline-model]"), view.script);
  assert.equal(view.container.getAttribute("data-pipeline-hydrated"), "graphpaper");
  assert.equal(state.calls.at(-1).options.legendVisible, false);
  assert.equal(state.calls.at(-1).options.direction, "DOWN");
  assert.equal(view.host.querySelector(".pipeline-details"), null);
  handle.destroy();
  assert.equal(view.canvas.childNodes[0], view.original);
  assert.equal(handle.select("normalize"), false);
});

test("valid deep links preserve unrelated hash parameters and existing history state", async () => {
  const view = fixture("#tab=policy&node=normalize");
  const picks = [];
  const handle = await mountPipelineViewer(view.container, { onSelect: (pick) => picks.push(pick) });
  assert.equal(picks[0].nodeId, "normalize");
  assert.equal(view.window.history.writes.length, 0);
  const historyState = view.window.history.state;
  assert.equal(handle.select("outage-signal"), true);
  assert.equal(view.window.location.hash, "#tab=policy&node=outage-signal");
  assert.equal(view.window.history.state, historyState);
  assert.equal(handle.select("missing"), false);
  assert.equal(view.window.location.hash, "#tab=policy&node=outage-signal");
  handle.select(null);
  assert.equal(view.window.location.hash, "#tab=policy");
  view.window.location.hash = "#tab=policy&node=normalize";
  view.window.fire("hashchange");
  assert.equal(state.selections.get(view.canvas).current, "normalize");
  const writes = view.window.history.writes.length;
  view.window.location.hash = "#tab=policy&node=missing";
  view.window.fire("hashchange");
  assert.equal(state.selections.get(view.canvas).current, null);
  assert.equal(view.window.history.writes.length, writes);
  assert.equal(view.window.location.hash, "#tab=policy&node=missing");
  handle.destroy();
});

test("custom and disabled deep links respect the caller's navigation seam", async () => {
  const custom = fixture("#pick=normalize&node=leave-me");
  const first = await mountPipelineViewer(custom.container, { deepLink: { param: "pick" } });
  first.select("outage-signal");
  assert.equal(new URLSearchParams(custom.window.location.hash.slice(1)).get("node"), "leave-me");
  assert.equal(new URLSearchParams(custom.window.location.hash.slice(1)).get("pick"), "outage-signal");
  first.destroy();
  const disabled = fixture("#node=normalize");
  const second = await mountPipelineViewer(disabled.container, { deepLink: false });
  assert.equal(state.selections.get(disabled.canvas).current, null);
  second.select("outage-signal");
  assert.equal(disabled.window.location.hash, "#node=normalize");
  assert.equal(disabled.window.listeners.get("hashchange")?.size ?? 0, 0);
  second.destroy();
});

test("a slower A response cannot overwrite B or a newer A request", async () => {
  const view = fixture();
  const pending = [];
  const handle = await mountPipelineViewer(view.container, { details: (nodeId) => new Promise((resolve) => pending.push({ nodeId, resolve })) });
  handle.select("normalize"); handle.select("outage-signal"); handle.select("normalize");
  assert.equal(pending.length, 3);
  pending[2].resolve(details("normalize", "Newest A")); await flush();
  const body = view.host.querySelector(".pipeline-details-body");
  assert.match(body.textContent, /Newest A/u);
  pending[0].resolve(details("normalize", "Obsolete A")); pending[1].resolve(details("outage-signal", "Obsolete B")); await flush();
  assert.match(body.textContent, /Newest A/u);
  assert.doesNotMatch(body.textContent, /Obsolete/u);
  const requests = pending.length; handle.select("normalize"); assert.equal(pending.length, requests);
  handle.destroy();
});

test("mismatched graph/node identities and rejected details show only unavailable text", async () => {
  const view = fixture();
  let response = { ...details("normalize", "DO_NOT_RENDER"), graph: { ...model.metadata.pipeline.graph, digest: "0".repeat(64) } };
  const handle = await mountPipelineViewer(view.container, { details: async () => { if (response instanceof Error) throw response; return response; } });
  for (const candidate of [response, details("another-node", "DO_NOT_RENDER"), new Error("SECRET_ERROR"), undefined]) {
    response = candidate; handle.select(null); handle.select("normalize"); await flush();
    const text = view.host.querySelector(".pipeline-details-body").textContent;
    assert.equal(text, "Details for this version are unavailable.");
    assert.doesNotMatch(text, /DO_NOT_RENDER|SECRET_ERROR/u);
  }
  handle.destroy();
});

test("matching graph and node IDs cannot substitute details for another node kind", async () => {
  const view = fixture();
  let response = details("normalize", "WRONG_KIND");
  response.sealed.kind = "human";
  const handle = await mountPipelineViewer(view.container, { details: async () => response });
  handle.select("normalize"); await flush();
  assert.equal(view.host.querySelector(".pipeline-details-body").textContent, "Details for this version are unavailable.");
  response = details("normalize", "Correct kind");
  handle.select(null); handle.select("normalize"); await flush();
  assert.match(view.host.querySelector(".pipeline-details-body").textContent, /Correct kind/u);
  handle.destroy();
});

test("details render strings through DOM text and endpoints use only supplied model words", async () => {
  const view = fixture(); let reads = 0;
  const dangerous = '<img src=x onerror="sideEffect()">';
  const handle = await mountPipelineViewer(view.container, { details: async (nodeId) => { reads += 1; return JSON.stringify(details(nodeId, dangerous)); } });
  handle.select("normalize"); await flush();
  assert.ok(view.host.querySelector(".pipeline-details-body").textContent.includes(dangerous));
  assert.equal(view.host.querySelectorAll("img").length, 0);
  handle.select("endpoint:on-call"); await flush();
  assert.equal(reads, 1);
  assert.equal(view.host.querySelector(".pipeline-details-title").textContent, "On-call page");
  handle.destroy();
});

test("keyboard selection opens a focusable sibling panel; close and Escape restore node focus", async () => {
  const view = fixture();
  const handle = await mountPipelineViewer(view.container, { details: async (nodeId) => details(nodeId) });
  keyboardPick(view.canvas, "normalize");
  const panel = view.host.querySelector(".pipeline-details");
  assert.equal(panel.parentElement, view.container.parentElement);
  assert.equal(panel.hidden, false);
  assert.equal(panel.tabIndex, -1);
  assert.equal(view.document.activeElement, panel);
  panel.querySelector(".pipeline-details-close").fire("click");
  assert.equal(panel.hidden, true);
  assert.equal(view.document.activeElement.getAttribute("data-diagram-node"), "normalize");
  keyboardPick(view.canvas, "outage-signal");
  const event = panel.fire("keydown", { key: "Escape" });
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.equal(panel.hidden, true);
  assert.equal(view.document.activeElement.getAttribute("data-diagram-node"), "outage-signal");
  handle.destroy();
});

test("mouse node presses retain their click target with renderer pointer capture; drags do not select", async () => {
  const view = fixture(); const picks = [];
  const handle = await mountPipelineViewer(view.container, { onSelect: (pick) => picks.push(pick) });
  const svg = view.canvas.querySelector("svg");
  const node = view.canvas.querySelector('[data-diagram-node="normalize"]');
  const rect = view.document.createElement("rect"); node.append(rect);
  let captured = false;
  svg.hasPointerCapture = (id) => captured && id === 1;
  svg.releasePointerCapture = (id) => { assert.equal(id, 1); captured = false; };
  bindDiagramInteractions(view.canvas, model, state.calls.at(-1).options);
  const down = (target, pointerType = "mouse", button = 0) => {
    captured = true; // The renderer captured on the SVG before this event bubbles.
    view.canvas.fire("pointerdown", { target, pointerType, button, pointerId: 1, clientX: 10, clientY: 10 });
  };
  try {
    down(rect);
    assert.equal(captured, false, "a stationary mouse click must keep the node target");
    view.canvas.fire("click", { target: captured ? svg : rect });
    assert.equal(picks.at(-1).nodeId, "normalize");
    assert.equal(picks.at(-1).source, "pointer");
    realClear(view.canvas);
    const count = picks.length;
    down(rect);
    view.canvas.fire("pointermove", { target: rect, clientX: 80, clientY: 10 });
    view.canvas.fire("click", { target: rect });
    assert.equal(picks.length, count, "renderer travel threshold still suppresses a drag release");
    for (const [target, type, button] of [[svg, "mouse", 0], [rect, "touch", 0], [rect, "pen", 0], [rect, "mouse", 2]]) {
      down(target, type, button);
      assert.equal(captured, true, "other gestures retain renderer capture");
    }
  } finally { realCleanup(view.canvas); handle.destroy(); }
  assert.equal(view.canvas.listeners.get("pointerdown").size, 0);
});

test("selection callbacks and panel text use the frozen snapshot rather than renderer node copies", async () => {
  const view = fixture(); const picks = [];
  const handle = await mountPipelineViewer(view.container, {
    details: async (nodeId) => details(nodeId), onSelect: (pick) => picks.push(pick)
  });
  const copied = { ...model.nodes.find((node) => node.id === "normalize"), title: "MUTABLE_RENDERER_COPY" };
  keyboardPick(view.canvas, "normalize", copied);
  const pick = picks[0];
  assert.notEqual(pick.node, copied);
  assert.equal(pick.node, state.calls.at(-1).model.nodes.find((node) => node.id === "normalize"));
  for (const record of [pick, pick.node, pick.node.metadata, ...pick.node.rows]) {
    assert.equal(Object.getPrototypeOf(record), null);
    assert.equal(Object.isFrozen(record), true);
  }
  assert.equal(Object.isFrozen(pick.node.rows), true);
  assert.throws(() => { pick.node.title = "changed"; }, TypeError);
  assert.equal(view.host.querySelector(".pipeline-details-title").textContent, "Normalizer (1)");
  handle.destroy();
});

test("destroy restores original children, removes owned listeners/panel, and ignores pending details", async () => {
  const view = fixture(); let resolve;
  view.container.setAttribute("data-pipeline-hydrated", "original");
  const handle = await mountPipelineViewer(view.container, { details: () => new Promise((done) => { resolve = done; }) });
  handle.select("normalize");
  const panel = view.host.querySelector(".pipeline-details");
  const body = panel.querySelector(".pipeline-details-body");
  const close = panel.querySelector(".pipeline-details-close");
  const cleanups = state.cleanups;
  handle.destroy(); handle.destroy();
  assert.equal(state.cleanups, cleanups + 1);
  assert.equal(view.canvas.childNodes[0], view.original);
  assert.equal(view.container.querySelector("script[data-pipeline-model]"), view.script);
  assert.equal(view.container.getAttribute("data-pipeline-hydrated"), "original");
  assert.equal(view.host.querySelector(".pipeline-details"), null);
  assert.equal(view.host.classList.contains("pipeline-viewer-host"), false);
  assert.equal(view.window.listeners.get("hashchange").size, 0);
  assert.equal(panel.listeners.get("keydown").size, 0);
  assert.equal(close.listeners.get("click").size, 0);
  const old = body.textContent; resolve(details("normalize", "TOO_LATE")); await flush();
  assert.equal(body.textContent, old);
});

test("failed hydration restores SSR even after the renderer partially replaced its children", async () => {
  const view = fixture();
  state.beforeHydrate = async (canvas) => { canvas.replaceChildren(canvas.ownerDocument.createElement("div")); throw new Error("layout fixture failed"); };
  try { await assert.rejects(mountPipelineViewer(view.container), /layout fixture failed/u); }
  finally { state.beforeHydrate = undefined; }
  assert.equal(view.canvas.childNodes[0], view.original);
  assert.equal(view.container.classList.contains("pipeline-viewer"), false);
  assert.equal(view.container.getAttribute("data-pipeline-hydrated"), null);
  assert.equal(view.host.querySelector(".pipeline-details"), null);
  const direct = await mountPipelineViewer(view.canvas, { model }); direct.destroy();
  const handle = await mountPipelineViewer(view.container); handle.destroy();
});

test("the same container cannot mount twice, and sibling viewers share host class ownership", async () => {
  const first = fixture(); const second = fixture("", first);
  const a = await mountPipelineViewer(first.container, { details: async (nodeId) => details(nodeId) });
  await assert.rejects(mountPipelineViewer(first.container), /already mounted/u);
  const b = await mountPipelineViewer(second.container, { details: async (nodeId) => details(nodeId), deepLink: false });
  a.destroy(); assert.equal(first.host.classList.contains("pipeline-viewer-host"), true);
  b.destroy(); assert.equal(first.host.classList.contains("pipeline-viewer-host"), false);
});

test("wrapper, direct canvas, and ancestor aliases cannot concurrently claim the same renderer", async () => {
  const view = fixture(); let release;
  state.beforeHydrate = () => new Promise((resolve) => { release = resolve; });
  const mounting = mountPipelineViewer(view.container);
  try {
    await assert.rejects(mountPipelineViewer(view.canvas, { model }), /already mounted/u);
    await assert.rejects(mountPipelineViewer(view.host, { model }), /already mounted/u);
    await assert.rejects(mountPipelineViewer(view.container), /already mounted/u);
  } finally { state.beforeHydrate = undefined; release(); }
  const handle = await mounting;
  await assert.rejects(mountPipelineViewer(view.canvas, { model }), /already mounted/u);
  handle.destroy();
  const direct = await mountPipelineViewer(view.canvas, { model });
  await assert.rejects(mountPipelineViewer(view.container), /already mounted/u);
  await assert.rejects(mountPipelineViewer(view.host, { model }), /already mounted/u);
  direct.destroy();
  const next = await mountPipelineViewer(view.container); next.destroy();
});

test("two mounted copies of the same model use distinct safe SVG marker IDs", async () => {
  const first = fixture(); const second = fixture("", first);
  const a = await mountPipelineViewer(first.container);
  const firstMarker = state.calls.at(-1).options.markerId;
  const b = await mountPipelineViewer(second.container);
  const secondMarker = state.calls.at(-1).options.markerId;
  assert.match(firstMarker, /^[A-Za-z][A-Za-z0-9_-]*$/u);
  assert.match(secondMarker, /^[A-Za-z][A-Za-z0-9_-]*$/u);
  assert.notEqual(firstMarker, secondMarker);
  assert.equal(state.calls.at(-2).model.id, state.calls.at(-1).model.id);
  a.destroy(); b.destroy();
});

test("malformed models/options and accessor callbacks are rejected before DOM replacement", async () => {
  const view = fixture(); let calls = 0;
  await assert.rejects(mountPipelineViewer(view.container, { model: "not JSON" }));
  const getter = {}; Object.defineProperty(getter, "model", { enumerable: true, get() { calls += 1; return model; } });
  await assert.rejects(mountPipelineViewer(view.container, getter));
  for (const options of [{ update: () => {} }, { onSelect: 2 }, { legendVisible: "yes" }, { deepLink: { param: "" } }]) {
    await assert.rejects(mountPipelineViewer(view.container, options));
  }
  const engine = {}; Object.defineProperty(engine, "layout", { get() { calls += 1; return () => {}; } });
  await assert.rejects(mountPipelineViewer(view.container, { layoutEngine: engine }));
  assert.equal(calls, 0);
  assert.equal(view.canvas.childNodes[0], view.original);
  assert.equal(view.container.getAttribute("data-pipeline-hydrated"), null);
});

test("explicit JSON models and captured class layout methods work without reading an inert script", async () => {
  const view = fixture(); view.script.remove(); let called = 0;
  class Engine { layout(graph) { called += 1; assert.equal(this, engine); return Promise.resolve(graph); } }
  const engine = new Engine();
  const handle = await mountPipelineViewer(view.container, { model: JSON.stringify(model), layoutEngine: engine });
  const captured = state.calls.at(-1).options.layoutEngine;
  Engine.prototype.layout = () => { throw new Error("substituted method"); };
  const supplied = validLayout();
  const returned = await captured.layout(supplied); assert.equal(called, 1);
  assert.notEqual(returned, supplied);
  assert.equal(Object.isFrozen(returned.children), true);
  handle.destroy();
});

test("malformed injected layouts are refused before real graphpaper can drop nodes or paint invalid geometry", async () => {
  const missing = validLayout(); missing.children.pop();
  const duplicate = validLayout(); duplicate.children[1] = { ...duplicate.children[0] };
  const unknown = validLayout(); unknown.children[0].id = "not-a-model-node";
  const invalid = validLayout(); invalid.children[0].x = Infinity;
  let getters = 0;
  const getter = validLayout(); Object.defineProperty(getter.children[0], "x", { enumerable: true, get() { getters += 1; return 0; } });
  for (const returned of [{}, missing, duplicate, unknown, invalid, getter]) {
    const view = fixture();
    const handle = await mountPipelineViewer(view.container, { layoutEngine: { async layout() { return returned; } } });
    const options = state.calls.at(-1).options;
    await assert.rejects(options.layoutEngine.layout({}), (error) => error.message === "Pipeline layout engine failed");
    const warnings = []; const originalWarn = console.warn;
    let layout;
    try {
      console.warn = (...args) => warnings.push(args.map(String).join(" "));
      layout = await realLayoutDiagram(model, options);
    } finally { console.warn = originalWarn; handle.destroy(); }
    assert.equal(layout.positions.size, model.nodes.length);
    assert.equal(layout.sourceLabel, options.elkErrorSourceLabel);
    assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
    assert.ok(warnings.some((warning) => warning.includes("Pipeline layout engine failed")));
  }
  assert.equal(getters, 0);
});

test("adapter options mask inherited execution hooks and sanitize injected layout failures", async () => {
  const view = fixture();
  const handle = await mountPipelineViewer(view.container, { layoutEngine: { async layout() { throw new Error("PRIVATE_LAYOUT_ERROR"); } } });
  const options = state.calls.at(-1).options;
  for (const key of ["caption", "resolveScope", "hasScope", "onScopeChange", "onStageChange"]) {
    assert.equal(Object.hasOwn(options, key), true);
    assert.equal(options[key], undefined);
  }
  assert.equal(options.drillDown, false);
  assert.equal(options.stageControls, false);
  for (const kind of ["code", "model", "human", "agent", "callback", "endpoint", "terminal", "custom"]) {
    assert.equal(Object.hasOwn(options.nodeRenderers, kind), true);
    assert.equal(options.nodeRenderers[kind], undefined);
  }
  await assert.rejects(options.layoutEngine.layout({}), (error) => error.message === "Pipeline layout engine failed");
  handle.destroy();
});

test("consumer selection exceptions and accessor detail payloads do not execute or strand the viewer", async () => {
  const view = fixture(); let getters = 0;
  const payload = details("normalize");
  Object.defineProperty(payload, "question", { enumerable: true, get() { getters += 1; return "UNSAFE"; } });
  const handle = await mountPipelineViewer(view.container, {
    details: async () => payload,
    onSelect: () => { throw new Error("consumer callback failed"); }
  });
  assert.equal(handle.select("normalize"), true);
  await flush();
  assert.equal(getters, 0);
  assert.equal(view.host.querySelector(".pipeline-details-body").textContent, "Details for this version are unavailable.");
  assert.equal(handle.select(null), true);
  assert.equal(view.host.querySelector(".pipeline-details").hidden, true);
  handle.destroy();
});

test("an absent/ambiguous embedded model or disconnected container is refused", async () => {
  const absent = fixture(); absent.script.remove();
  await assert.rejects(mountPipelineViewer(absent.container), /embedded|model/u);
  const ambiguous = fixture();
  const duplicate = ambiguous.document.createElement("script"); duplicate.setAttribute("type", "application/json"); duplicate.setAttribute("data-pipeline-model", ""); duplicate.textContent = JSON.stringify(model); ambiguous.container.append(duplicate);
  await assert.rejects(mountPipelineViewer(ambiguous.container), /exactly one/u);
  const disconnected = fixture(); disconnected.container.remove();
  await assert.rejects(mountPipelineViewer(disconnected.container), /connected/u);
});
