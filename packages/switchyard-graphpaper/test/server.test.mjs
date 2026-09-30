import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import test from "node:test";
import { renderPipelineFigure, viewerAssets } from "switchyard-graphpaper/server";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/support-triage.static.golden.json", import.meta.url), "utf8"));
const embeddedModel = (html) => {
  const script = /<script\b[^>]*\bdata-pipeline-model[^>]*>([\s\S]*?)<\/script>/u.exec(html);
  assert.ok(script, "figure must carry one inert model script");
  return JSON.parse(script[1]);
};

function positions(graph) {
  return {
    ...graph,
    width: 680,
    height: 400,
    children: graph.children.map((child, index) => ({ ...child, x: index * 210, y: 20 })),
    edges: graph.edges.map((edge) => ({ ...edge, sections: [{ startPoint: { x: 20, y: 20 }, endPoint: { x: 80, y: 80 } }] }))
  };
}

test("server renders a static figure, a hydration canvas, and inert exact model JSON", async () => {
  const model = fixture();
  const original = JSON.stringify(model);
  const html = await renderPipelineFigure(model);
  assert.match(html, /^<figure class="pipeline-viewer pipeline-diagram"/u);
  assert.ok(html.includes(`id="${model.id}-figure"`));
  assert.ok(html.includes(`id="${model.id}-figure-model"`));
  assert.match(html, /<div class="graphpaper" data-pipeline-canvas>/u);
  assert.match(html, /<svg\b/u);
  assert.match(html, /node-type-model/u);
  assert.match(html, /edge-kind-exit/u);
  assert.match(html, /--pipeline-diagram-width:\d+px;--pipeline-diagram-height:\d+px/u);
  assert.match(html, /built-in layered layout/u);
  assert.equal((html.match(/<script\b/gu) ?? []).length, 1);
  assert.match(html, /<\/div><script type="application\/json" data-pipeline-model/u);
  assert.doesNotMatch(html, /<script[^>]*\bsrc=|<link\b|\bonload=|\bonclick=/u);
  assert.deepEqual(embeddedModel(html), model);
  assert.equal(JSON.stringify(model), original);
  assert.equal(await renderPipelineFigure(model), html);
});

test("server escapes markup and script terminators without changing consumer text", async () => {
  const model = fixture();
  const text = '</script><img src=x onerror="alert(1)"> & <svg>\u2028\u2029';
  model.title = text;
  model.nodes[0].title = text;
  model.nodes[0].description = text;
  const html = await renderPipelineFigure(model);
  assert.equal((html.match(/<script\b/gu) ?? []).length, 1);
  assert.equal((html.match(/<\/script>/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /<img\b/u);
  assert.ok(html.includes("&lt;/script&gt;"));
  const inert = /<script\b[^>]*>([\s\S]*?)<\/script>/u.exec(html)[1];
  assert.doesNotMatch(inert, /[<>&\u2028\u2029]/u);
  assert.ok(inert.includes("\\u003c/script\\u003e"));
  assert.ok(inert.includes("\\u2028\\u2029"));
  assert.equal(embeddedModel(html).title, text);
  assert.equal(embeddedModel(html).nodes[0].description, text);
});

test("server element IDs are explicit, validated, distinct, and isolate SVG markers", async () => {
  const first = await renderPipelineFigure(fixture(), { figureId: "review:first", modelElementId: "model:first" });
  const second = await renderPipelineFigure(fixture(), { figureId: "review-first", modelElementId: "model-first" });
  assert.ok(first.includes('id="review:first"'));
  assert.ok(first.includes('id="model:first"'));
  const marker = (html) => /<marker[^>]*\bid="([^"]+)"/u.exec(html)?.[1];
  assert.ok(marker(first));
  assert.notEqual(marker(first), marker(second));
  const automatic = await renderPipelineFigure(fixture(), { figureId: "another-figure" });
  assert.ok(automatic.includes('id="another-figure-model"'));
  for (const id of ["", "has spaces", 'x" onclick="bad', "x<y", "x\u0000y", "a".repeat(201), null, undefined]) {
    await assert.rejects(renderPipelineFigure(fixture(), { figureId: id }), /figureId/u);
    await assert.rejects(renderPipelineFigure(fixture(), { modelElementId: id }), /modelElementId/u);
  }
  await assert.rejects(renderPipelineFigure(fixture(), { figureId: "same", modelElementId: "same" }), /differ/u);
});

test("server uses an injected engine with its receiver captured before an async boundary", async () => {
  const model = fixture();
  const originalTitle = model.title;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  let receiver;
  const engine = {
    async layout(graph) {
      calls += 1;
      receiver = this;
      await pending;
      return positions(graph);
    }
  };
  const rendering = renderPipelineFigure(model, { layoutEngine: engine });
  model.title = "Changed after invocation";
  engine.layout = () => { throw new Error("replacement must not run"); };
  release();
  const html = await rendering;
  assert.equal(calls, 1);
  assert.equal(receiver, engine);
  assert.equal(embeddedModel(html).title, originalTitle);
  assert.match(html, /graphpaper · ELK/u);
  assert.doesNotMatch(html, /ELK unavailable|ELK failed/u);
});

test("server supports real ELK through graphpaper's public injected-engine API", async () => {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const html = await renderPipelineFigure(fixture(), { layoutEngine: new ELK() });
  assert.match(html, /<svg\b/u);
  assert.match(html, /graphpaper · ELK/u);
  assert.doesNotMatch(html, /ELK unavailable|ELK failed/u);
});

test("server falls back on engine failure without inspecting caller-owned thrown values", async (t) => {
  let inspected = 0;
  const thrown = { [inspect.custom]() { inspected += 1; return "unsafe inspection"; } };
  const warnings = [];
  t.mock.method(console, "warn", (...items) => {
    warnings.push(items);
    for (const item of items) inspect(item);
  });
  const html = await renderPipelineFigure(fixture(), { layoutEngine: { layout() { throw thrown; } } });
  assert.equal(inspected, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0][1] instanceof Error);
  assert.equal(warnings[0][1].message, "pipeline figure layout engine failed or returned invalid data");
  assert.match(html, /ELK failed/u);
  assert.match(html, /<svg\b/u);
});

test("server snapshots layout results before getters or extreme geometry reach the renderer", async (t) => {
  t.mock.method(console, "warn", () => {});
  let getters = 0;
  const accessorResult = Object.defineProperty({}, "children", { enumerable: true, get() { getters += 1; return []; } });
  const first = await renderPipelineFigure(fixture(), { layoutEngine: { layout: async () => accessorResult } });
  assert.equal(getters, 0);
  assert.match(first, /ELK failed/u);
  for (const width of [Infinity, NaN, 1_000_001, -1, '0" onload="bad']) {
    const html = await renderPipelineFigure(fixture(), { layoutEngine: { layout: async (graph) => ({ ...positions(graph), width }) } });
    assert.match(html, /ELK failed/u);
    assert.doesNotMatch(html, /(?:Infinity|NaN)px|onload="bad/u);
  }
});

test("server falls back when an injected layout would omit, duplicate, or invent model nodes", async (t) => {
  t.mock.method(console, "warn", () => {});
  const model = fixture();
  for (const change of [
    () => false,
    () => ({}),
    (graph) => ({ ...positions(graph), children: [] }),
    (graph) => {
      const result = positions(graph);
      result.children[0].id = "not-a-model-node";
      return result;
    },
    (graph) => {
      const result = positions(graph);
      result.children[0].id = result.children[1].id;
      return result;
    }
  ]) {
    const html = await renderPipelineFigure(model, { layoutEngine: { layout: async (graph) => change(graph) } });
    assert.match(html, /ELK failed/u);
    for (const node of model.nodes) assert.ok(html.includes(`data-diagram-node="${node.id}"`), `fallback must still show ${node.id}`);
  }
});

test("server falls back on malformed section points without emitting nonfinite SVG paths", async (t) => {
  t.mock.method(console, "warn", () => {});
  const model = fixture();
  const point = { x: 20, y: 30 };
  for (const [label, sections] of [
    ["nonarray sections", {}],
    ["null section", [null]],
    ["missing start point", [{ endPoint: point }]],
    ["missing end point", [{ startPoint: point }]],
    ["start point missing y", [{ startPoint: { x: 20 }, endPoint: point }]],
    ["end point missing x", [{ startPoint: point, endPoint: { y: 30 } }]],
    ["array point", [{ startPoint: [20, 30], endPoint: point }]],
    ["nonarray bend points", [{ startPoint: point, endPoint: point, bendPoints: {} }]],
    ["bend point missing y", [{ startPoint: point, endPoint: point, bendPoints: [{ x: 20 }] }]],
    ["nonfinite bend point", [{ startPoint: point, endPoint: point, bendPoints: [{ x: 20, y: Infinity }] }]]
  ]) {
    const html = await renderPipelineFigure(model, { layoutEngine: { layout: async (graph) => {
      const result = positions(graph);
      result.edges[0].sections = sections;
      return result;
    } } });
    assert.match(html, /ELK failed/u, label);
    assert.doesNotMatch(html, /(?:NaN|Infinity)/u, label);
    for (const node of model.nodes) assert.ok(html.includes(`data-diagram-node="${node.id}"`), `${label}: fallback must still show ${node.id}`);
  }
});

test("server rejects accessor and Proxy model/options/engine input without executing it", async () => {
  let accesses = 0;
  const trap = () => { accesses += 1; throw new Error("must not run"); };
  const handlers = { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap };
  await assert.rejects(renderPipelineFigure(new Proxy(fixture(), handlers)), /Proxy|Proxies/u);
  await assert.rejects(renderPipelineFigure(fixture(), new Proxy({}, handlers)), /Proxy|Proxies/u);
  await assert.rejects(renderPipelineFigure(fixture(), { layoutEngine: new Proxy({}, handlers) }), /Proxy|Proxies/u);
  const model = fixture();
  Object.defineProperty(model, "title", { enumerable: true, get: trap });
  await assert.rejects(renderPipelineFigure(model), /data|descriptor|accessor/u);
  const options = Object.defineProperty({}, "layoutEngine", { enumerable: true, get: trap });
  await assert.rejects(renderPipelineFigure(fixture(), options), /data|descriptor|accessor/u);
  const engine = Object.defineProperty({}, "layout", { enumerable: true, get: trap });
  await assert.rejects(renderPipelineFigure(fixture(), { layoutEngine: engine }), /data|descriptor|accessor/u);
  assert.equal(accesses, 0);
});

test("server rejects malformed or future-mode models and executable option extensions", async () => {
  const model = fixture();
  model.metadata.pipeline.mode = "run";
  await assert.rejects(renderPipelineFigure(model), /static|mode/u);
  const wrongSchema = fixture();
  wrongSchema.metadata.pipeline.schemaVersion = "switchyard-diagram.v2";
  await assert.rejects(renderPipelineFigure(wrongSchema), /schema/u);
  for (const options of [{ layoutEngine: null }, { layoutEngine: {} }, { nodeRenderers: {} }, { caption: () => "<script>bad</script>" }]) {
    await assert.rejects(renderPipelineFigure(fixture(), options));
  }
  let serialized = 0;
  const serializable = fixture();
  serializable.toJSON = () => { serialized += 1; return {}; };
  await assert.rejects(renderPipelineFigure(serializable));
  assert.equal(serialized, 0);
});

test("server rendering cannot inherit executable caption or renderer hooks from ambient prototypes", async () => {
  const keys = ["caption", "code", "model", "custom", "hasScope"];
  const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  let calls = 0;
  const execute = () => { calls += 1; throw new Error("inherited hook must not run"); };
  try {
    Object.defineProperty(Object.prototype, "caption", { configurable: true, value: execute });
    Object.defineProperty(Object.prototype, "code", { configurable: true, value: { measure: execute, render: execute } });
    Object.defineProperty(Object.prototype, "model", { configurable: true, value: { measure: execute, render: execute } });
    Object.defineProperty(Object.prototype, "custom", { configurable: true, value: { measure: execute, render: execute } });
    Object.defineProperty(Object.prototype, "hasScope", { configurable: true, value: execute });
    const html = await renderPipelineFigure(fixture());
    assert.match(html, /<svg\b/u);
    assert.equal(calls, 0);
  } finally {
    for (const key of keys) {
      const descriptor = originals.get(key);
      if (descriptor === undefined) delete Object.prototype[key];
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }
});

test("viewerAssets exposes only the fixed installed files with immutable exact ETags", () => {
  const assets = viewerAssets();
  assert.deepEqual(Object.keys(assets).sort(), ["diagram.css", "elk.js", "graphpaper.js", "pipeline.css", "types.js", "viewer-data.js", "viewer-defaults.js", "viewer.js"]);
  assert.equal(Object.getPrototypeOf(assets), null);
  assert.equal(Object.isFrozen(assets), true);
  for (const [name, asset] of Object.entries(assets)) {
    assert.equal(Object.getPrototypeOf(asset), null);
    assert.equal(Object.isFrozen(asset), true);
    assert.ok(asset.body.length > 0);
    assert.equal(asset.contentType, name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
    assert.equal(asset.etag, `"${createHash("sha256").update(asset.body, "utf8").digest("hex")}"`);
  }
  assert.equal(viewerAssets(), assets);
  assert.equal(assets["viewer.js"].body.split('from "./graphpaper.js"').length, 2);
  assert.ok(!assets["viewer.js"].body.includes('from "@scshafe/graphpaper"'));
  for (const name of ["viewer.js", "viewer-data.js", "viewer-defaults.js", "types.js"]) {
    assert.doesNotMatch(assets[name].body, /(?:from|import\()\s*["'](?:node:|@scshafe\/switchyard)/u);
  }
});

test("served viewer ESM imports form a complete local asset set with no runtime Node or engine dependency", () => {
  const assets = viewerAssets();
  const modules = Object.fromEntries(["viewer.js", "viewer-data.js", "viewer-defaults.js", "types.js", "graphpaper.js"].map((name) => [name, assets[name].body]));
  for (const [name, body] of Object.entries(modules)) {
    assert.doesNotMatch(body, /\bimport\s*\(/u, `${name} must not load dynamic modules outside the asset set`);
  }
  // Use Node's module parser without evaluating any source. SourceTextModule
  // needs this flag on the supported Node releases; the parser child emits
  // dependency names only and receives source bytes over stdin, not argv.
  const parser = spawnSync(process.execPath, ["--no-warnings", "--experimental-vm-modules", "--input-type=module", "-e", `
    import { SourceTextModule } from "node:vm";
    import { readFileSync } from "node:fs";
    const modules = JSON.parse(readFileSync(0, "utf8"));
    const dependencies = Object.fromEntries(Object.entries(modules).map(([name, source]) =>
      [name, new SourceTextModule(source, { identifier: name }).dependencySpecifiers]));
    process.stdout.write(JSON.stringify(dependencies));
  `], { input: JSON.stringify(modules), encoding: "utf8" });
  assert.equal(parser.status, 0, parser.stderr);
  const dependencies = JSON.parse(parser.stdout);
  for (const [name, imports] of Object.entries(dependencies)) {
    for (const specifier of imports) {
      assert.match(specifier, /^\.\/[a-z0-9-]+\.js$/u, `${name} must import a same-directory served module`);
      assert.ok(Object.hasOwn(modules, specifier.slice(2)), `${name} imports missing asset ${specifier}`);
    }
  }
});

test("shipped CSS keeps details in the viewport and bounds the canvas despite renderer inline SVG sizing", () => {
  const css = viewerAssets()["pipeline.css"].body;
  // These are the host-layout rules; actual geometry is checked in the browser witness.
  assert.match(css, /\.pipeline-details\s*\{[^}]*position:\s*fixed;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*bottom:\s*0;/u);
  assert.match(css, /\.pipeline-viewer \[data-pipeline-canvas\]\s*\{[^}]*max-width:\s*var\(--pipeline-diagram-width,\s*100%\)/u);
  assert.match(css, /\.pipeline-viewer \.diagram-legend\s*\{[^}]*position:\s*static;/u);
  assert.match(css, /@media \(max-width: 680px\)\s*\{\s*\.pipeline-details\s*\{[^}]*top:\s*auto;[^}]*width:\s*100%;[^}]*max-height:\s*min\(65vh,\s*100%\)/u);
  assert.match(css, /\.pipeline-details\[hidden\]\s*\{\s*display:\s*none;/u);
});
