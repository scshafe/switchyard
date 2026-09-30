// Verify the separately packed SDK against exact, offline-installed peers.
// The renderer is the registry package @scshafe/graphpaper (GitHub Packages),
// pinned exactly by the root devDependency and the lockfile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sdkRoot = join(root, "packages/switchyard-graphpaper");
const graphpaperName = "@scshafe/graphpaper";
const graphpaperVersion = "0.5.2";
const graphpaperRoot = join(root, "node_modules", graphpaperName);
const scratch = await mkdtemp(join(tmpdir(), "switchyard-graphpaper-check-"));

const npmLogs = join(scratch, "npm-logs");

// npm prints only "A complete log of this run can be found in …" on some
// failures; the cause is in its debug log, so a failing npm call appends the
// tail of every debug log it wrote.
async function npmLogTail() {
  try {
    const names = (await readdir(npmLogs)).sort();
    const tails = [];
    for (const name of names) {
      const lines = (await readFile(join(npmLogs, name), "utf8")).trimEnd().split("\n");
      tails.push(`--- ${name} (last 60 lines)\n${lines.slice(-60).join("\n")}`);
    }
    return tails.join("\n");
  } catch {
    return "(no npm debug log)";
  }
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, npm_config_offline: options.online ? "false" : "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_logs_dir: npmLogs },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => { stdout.push(chunk); if (options.show) process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { stderr.push(chunk); if (options.show) process.stderr.write(chunk); });
  const [code] = await once(child, "close");
  const output = Buffer.concat(stdout);
  if (code !== 0) {
    const logs = command === "npm" ? `\n${await npmLogTail()}` : "";
    throw new Error(`${command} ${args.join(" ")} exited ${code}:\n${output.toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}${logs}`);
  }
  return output;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`non-regular SDK entry: ${relative(sdkRoot, path)}`);
  }
  return files.sort();
}

const engineImports = new Set([
  "@scshafe/switchyard",
  "@scshafe/switchyard/internal/capability",
  "@scshafe/switchyard/internal/evidence",
  "@scshafe/switchyard/internal/guards",
  "@scshafe/switchyard/contracts/digest",
  "@scshafe/switchyard/graph/definition",
  "@scshafe/switchyard/graph/compile",
  "@scshafe/switchyard/graph/display",
  "@scshafe/switchyard/graph/goals"
]);

function assertImportBoundary(path, source, knownFiles) {
  const sourceRoot = join(sdkRoot, path.includes(`${sep}src${sep}`) ? "src" : "lib");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const sourceTypeScript = sourceRoot.endsWith(`${sep}src`);
  const module = basename(path).replace(/(?:\.d)?\.(?:ts|js)$/, "");
  const browser = module === "browser";
  const server = module === "server";
  const browserSafe = new Set(["browser", "viewer-data", "viewer-defaults", "viewer-types", "types"]);
  const ambientEffects = new Set(["fetch", "XMLHttpRequest", "WebSocket", ...browser ? [] : ["document", "window"], "process", "setTimeout", "setInterval", "requestAnimationFrame", "eval", "Function"]);
  const inspect = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined) {
        assert.ok(ts.isStringLiteral(specifier), `${path}: module specifier must be literal`);
        const name = specifier.text;
        const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly === true;
        if (name === graphpaperName) {
          assert.ok(typeOnly || browser || server, `${path}: graphpaper runtime imports belong only to adapters`);
        } else if (name.startsWith(".")) {
          const target = resolve(dirname(path), sourceTypeScript ? name.replace(/\.js$/, ".ts") : name);
          assert.ok(target.startsWith(`${sourceRoot}${sep}`) && knownFiles.has(target), `${path}: relative import escapes package or is missing: ${name}`);
          const targetModule = basename(target).replace(/(?:\.d)?\.(?:ts|js)$/, "");
          if (browserSafe.has(module)) assert.ok(browserSafe.has(targetModule), `${path}: browser dependency reaches Node-only module ${name}`);
          if (!browser && !server) assert.ok(targetModule !== "browser" && targetModule !== "server", `${path}: core must not import adapters`);
        } else if (name.startsWith("node:")) {
          assert.ok(server && ["node:crypto", "node:fs", "node:module"].includes(name), `${path}: Node capabilities belong only to the server adapter`);
        } else {
          assert.ok(engineImports.has(name), `${path}: import outside static core allowlist: ${name}`);
          if (browserSafe.has(module)) assert.ok(typeOnly, `${path}: browser imports engine runtime`);
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error(`${path}: dynamic imports are outside the static core boundary`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      throw new Error(`${path}: CommonJS require is outside the static core boundary`);
    }
    // The browser capability walker must stop at intrinsic prototype roots;
    // reading that root is not dynamic code execution. Keep every other use
    // of Function (including constructors and aliases) outside the boundary.
    const intrinsicFunctionRoot = ts.isIdentifier(node) && node.text === "Function"
      && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
      && node.parent.name.text === "prototype"
      && ts.isBinaryExpression(node.parent.parent)
      && node.parent.parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (ts.isIdentifier(node) && ambientEffects.has(node.text) && !intrinsicFunctionRoot) {
      throw new Error(`${path}: ambient browser/process/effect capability is outside the static core: ${node.text}`);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(file);
}

function hash(algorithm, bytes, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

async function pack(packageRoot, directory) {
  await mkdir(directory);
  const report = JSON.parse((await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { cwd: packageRoot })).toString("utf8"));
  assert.equal(report.length, 1, "npm pack must return exactly one artifact");
  assert.equal(typeof report[0].filename, "string");
  const path = join(directory, report[0].filename);
  const bytes = await readFile(path);
  assert.equal(report[0].shasum, hash("sha1", bytes));
  assert.equal(report[0].integrity, `sha512-${hash("sha512", bytes, "base64")}`);
  return { path, report: report[0], bytes };
}

// A third-party peer is not re-packed from node_modules (npm 11.16 on hosted
// runners exits 1 silently packing elkjs there); the exact published tarball
// is fetched from its registry and must match the lockfile's integrity.
async function fetchLocked(lock, name, version, directory) {
  const escaped = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = new RegExp(`\\n  '?${escaped}'?:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\\}`).exec(lock);
  assert.ok(match, `pnpm-lock.yaml must lock ${name}@${version} by integrity`);
  await mkdir(directory);
  const report = JSON.parse((await run("npm", ["pack", `${name}@${version}`, "--json", "--ignore-scripts", "--pack-destination", directory], { cwd: directory, online: true })).toString("utf8"));
  assert.equal(report.length, 1, "npm pack must return exactly one artifact");
  const path = join(directory, report[0].filename);
  const bytes = await readFile(path);
  assert.equal(`sha512-${hash("sha512", bytes, "base64")}`, match[1], `${name}@${version} tarball must match the lockfile integrity`);
  return { path, report: report[0], bytes };
}

function parseManifest(text) {
  const entries = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-f0-9]{64})  ([^\u0000\r\n]+)$/.exec(line);
    assert.ok(match, `invalid SDK manifest line ${index + 1}`);
    const [, digest, path] = match;
    assert.ok(!path.startsWith("/") && !path.split("/").includes("..") && !entries.has(path), `unsafe or duplicate SDK manifest entry: ${path}`);
    entries.set(path, digest);
  }
  assert.ok(entries.size > 0, "SDK manifest is empty");
  return entries;
}

try {
  const packageJson = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
  assert.equal(packageJson.name, "switchyard-graphpaper");
  assert.equal(packageJson.version, "0.1.0");
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(packageJson.optionalDependencies ?? {}, {});
  assert.deepEqual(packageJson.peerDependencies, { "@scshafe/switchyard": "^2.1.0", [graphpaperName]: `^${graphpaperVersion}`, elkjs: "^0.10.2" });
  assert.deepEqual(packageJson.peerDependenciesMeta, { [graphpaperName]: { optional: true }, elkjs: { optional: true } }, "the renderer is needed only for its types and the adapters; ELK is optional except for full viewer assets");
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [".", "./browser", "./package.json", "./server"]);

  const sourceFiles = await walk(join(sdkRoot, "src"));
  const outputFiles = await walk(join(sdkRoot, "lib"));
  assert.ok(sourceFiles.length > 0, "SDK source is empty");
  const expectedOutputs = sourceFiles.flatMap((path) => {
    assert.ok(path.endsWith(".ts") && !path.endsWith(".d.ts"), `unexpected SDK source type: ${path}`);
    const stem = relative(join(sdkRoot, "src"), path).replace(/\.ts$/, "");
    return [join(sdkRoot, "lib", `${stem}.js`), join(sdkRoot, "lib", `${stem}.d.ts`)];
  });
  assert.deepEqual(outputFiles, expectedOutputs.sort(), "SDK artifacts must match source exactly, with no missing or orphan files");
  const knownFiles = new Set([...sourceFiles, ...outputFiles]);
  for (const path of knownFiles) {
    const bytes = await readFile(path);
    assert.ok(!bytes.includes(0), `raw NUL byte in SDK source/artifact: ${path}`);
    // Declarations refer to sibling .js entries and share the same allowlist.
    assertImportBoundary(path, bytes.toString("utf8"), knownFiles);
  }

  const expectedPayload = new Set([
    "LICENSE", "README.md", "package.json", "assets/pipeline.css",
    ...[...knownFiles].map((path) => relative(sdkRoot, path).split(sep).join("/"))
  ]);
  const first = await pack(sdkRoot, join(scratch, "sdk-first"));
  const second = await pack(sdkRoot, join(scratch, "sdk-second"));
  assert.equal(first.report.name, packageJson.name);
  assert.equal(first.report.version, packageJson.version);
  assert.ok(first.bytes.equals(second.bytes), "SDK npm packs must be byte-reproducible");
  const actualPayload = new Set(first.report.files.map((file) => file.path));
  assert.deepEqual([...actualPayload].sort(), [...expectedPayload].sort(), "SDK package payload must match exact source/artifact/readme/license set");

  const manifest = parseManifest(await readFile(join(root, "release", `${packageJson.name}-${packageJson.version}.payload.sha256`), "utf8"));
  assert.deepEqual([...manifest.keys()].sort(), [...expectedPayload].sort(), "SDK manifest must cover exact payload");
  const archiveEntries = (await run("tar", ["-tzf", first.path])).toString("utf8").trim().split(/\r?\n/);
  assert.equal(new Set(archiveEntries).size, archiveEntries.length, "SDK archive must not duplicate paths");
  assert.deepEqual(archiveEntries.sort(), [...expectedPayload].map((path) => `package/${path}`).sort());
  const verbose = (await run("tar", ["-tvzf", first.path])).toString("utf8").trim().split(/\r?\n/);
  assert.ok(verbose.every((line) => line.startsWith("-")), "SDK archive must contain only regular files");
  const forbiddenBytes = [/\/Users\//, /\/home\//, /~\//, /\.openclaw/, /\.mission-control/, /\b(?:file|link|workspace):/];
  for (const [path, digest] of manifest) {
    const bytes = await run("tar", ["-xOzf", first.path, `package/${path}`]);
    assert.ok(!bytes.includes(0), `raw NUL byte in SDK payload ${path}`);
    assert.equal(hash("sha256", bytes), digest, `SDK manifest digest mismatch for ${path}`);
    for (const pattern of forbiddenBytes) assert.doesNotMatch(bytes.toString("utf8"), pattern, `mutable local reference in SDK payload ${path}`);
  }

  const rootMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  assert.equal(rootMetadata.devDependencies[graphpaperName], graphpaperVersion, "the renderer dev dependency must be an exact registry version (LIB-09)");
  assert.equal(rootMetadata.devDependencies.graphpaper, undefined, "the unscoped graphpaper name must not be a dependency");
  // pnpm records a registry package as a packages: entry with an integrity hash
  // and the GitHub Packages tarball URL; Git, file, link and workspace sources are refused.
  const lockedGraphpaper = new RegExp(
    `\\n  '@scshafe/graphpaper@${graphpaperVersion.replaceAll(".", "\\.")}':\\n` +
    `    resolution: \\{integrity: sha512-[A-Za-z0-9+/]+={0,2}, tarball: https://npm\\.pkg\\.github\\.com/download/@scshafe/graphpaper/${graphpaperVersion.replaceAll(".", "\\.")}/[a-f0-9]{40}\\}\\n`
  );
  assert.match(lock, lockedGraphpaper, `pnpm-lock.yaml must lock ${graphpaperName} ${graphpaperVersion} from GitHub Packages by integrity`);
  assert.doesNotMatch(lock, /git\+(?:ssh|https):|github:|\b(?:file|link|workspace):/u, "pnpm-lock.yaml must not carry Git, file, link or workspace sources");
  const graphpaperMetadata = JSON.parse(await readFile(join(graphpaperRoot, "package.json"), "utf8"));
  assert.equal(graphpaperMetadata.name, graphpaperName);
  assert.equal(graphpaperMetadata.version, graphpaperVersion);
  assert.equal(graphpaperMetadata.exports["."].default, "./src/index.js");
  const engine = await pack(root, join(scratch, "engine"));
  const graphpaper = await pack(graphpaperRoot, join(scratch, "graphpaper"));
  const elk = await fetchLocked(lock, "elkjs", "0.10.2", join(scratch, "elk"));
  assert.equal(elk.report.name, "elkjs");
  assert.equal(elk.report.version, "0.10.2");
  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  await run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional", engine.path, first.path, graphpaper.path, elk.path], { cwd: consumer, show: true });
  await cp(join(sdkRoot, "test"), join(consumer, "test"), { recursive: true });
  await cp(join(root, "test/fixtures/switchyard"), join(consumer, "test/fixtures/switchyard"), { recursive: true });
  const testFiles = (await walk(join(consumer, "test"))).filter((path) => path.endsWith(".test.mjs"));
  assert.ok(testFiles.length > 0, "SDK packed consumer must run at least one test suite");
  await run(process.execPath, ["--test", ...testFiles], { cwd: consumer, show: true });

  await writeFile(join(consumer, "smoke.mjs"), `
import assert from "node:assert/strict";
import { compileGraph, projectGraphDisplay } from "@scshafe/switchyard";
import { buildPipelineDiagram, pipelineLegend, PIPELINE_RENDER_OPTIONS, PIPELINE_PRESENTATION_SCHEMA_VERSION } from "switchyard-graphpaper";
import { layoutDiagram, renderDiagramSvg } from "@scshafe/graphpaper";
import { renderPipelineFigure, viewerAssets } from "switchyard-graphpaper/server";
import ELK from "elkjs/lib/elk.bundled.js";
import { SUPPORT_TRIAGE_GRAPH, SUPPORT_TRIAGE_PRESENTATION, SUPPORT_TRIAGE_GOAL_MANIFEST } from "./test/fixtures/switchyard/support-triage-example.mjs";
const projection = projectGraphDisplay(compileGraph(SUPPORT_TRIAGE_GRAPH));
const model = buildPipelineDiagram({ projection, presentation: { ...SUPPORT_TRIAGE_PRESENTATION, schemaVersion: PIPELINE_PRESENTATION_SCHEMA_VERSION }, definition: SUPPORT_TRIAGE_GRAPH, goalManifest: SUPPORT_TRIAGE_GOAL_MANIFEST });
const before = JSON.stringify(model);
const options = { ...PIPELINE_RENDER_OPTIONS, legend: pipelineLegend() };
const layout = await layoutDiagram(model, options);
assert.ok(Number.isFinite(layout.width) && layout.width > 0);
assert.ok(Number.isFinite(layout.height) && layout.height > 0);
const svg = renderDiagramSvg(model, layout, options);
assert.ok(svg.includes("<svg") && svg.includes("Support triage"));
assert.ok(svg.includes("node-type-model") && svg.includes("edge-kind-exit"));
assert.equal(JSON.stringify(model), before, "renderer must accept frozen SDK data without changing it");
console.log("SDK packed renderer layout + SVG smoke passed (graphpaper built-in layout, no browser or ELK).");
const figure = await renderPipelineFigure(model, { layoutEngine: new ELK() });
assert.ok(figure.includes('data-pipeline-model') && figure.includes('graphpaper · ELK'));
const assets = viewerAssets();
assert.equal(Object.keys(assets).length, 8);
console.log("SDK packed server figure + ELK + complete viewer assets smoke passed.");
`);
  await run(process.execPath, ["smoke.mjs"], { cwd: consumer, show: true });

  await writeFile(join(consumer, "smoke.ts"), `
import { buildPipelineDiagram, validatePresentation, pipelineLegend, PIPELINE_RENDER_OPTIONS, PIPELINE_PRESENTATION_SCHEMA_VERSION, type PipelinePresentation, type BuildPipelineDiagramInput, type PipelineDiagramMetadata } from "switchyard-graphpaper";
import type { GraphDisplayProjection, GraphDefinition, GoalManifest } from "@scshafe/switchyard";
import type { DiagramModel, DiagramLegendEntry, DiagramRenderOptions } from "@scshafe/graphpaper";
import { renderPipelineFigure, viewerAssets, type RenderPipelineFigureOptions } from "switchyard-graphpaper/server";
import { mountPipelineViewer, type MountPipelineViewerOptions, type PipelineViewerHandle } from "switchyard-graphpaper/browser";
import type { NodeDetails } from "switchyard-graphpaper";
const projection = undefined as unknown as GraphDisplayProjection;
const definition = undefined as unknown as GraphDefinition;
const goalManifest = undefined as unknown as GoalManifest;
const presentation: PipelinePresentation = { schemaVersion: PIPELINE_PRESENTATION_SCHEMA_VERSION, title: "Typed fixture", nodes: {}, endpoints: [], terminals: [] };
const input: BuildPipelineDiagramInput = { projection, presentation, definition, goalManifest, historical: true };
const model: DiagramModel = buildPipelineDiagram(input);
const problems: readonly string[] = validatePresentation(projection, presentation, { definition, goalManifest });
const legend: readonly DiagramLegendEntry[] = pipelineLegend("static");
const options: DiagramRenderOptions = PIPELINE_RENDER_OPTIONS;
const metadata = undefined as unknown as PipelineDiagramMetadata;
// @ts-expect-error presentation is immutable
presentation.title = "changed";
// @ts-expect-error metrics mode remains proposed
pipelineLegend("metrics");
// @ts-expect-error execution overlay remains proposed
buildPipelineDiagram({ projection, presentation, overlay: {} });
void model; void problems; void legend; void options; void metadata;
const serverOptions: RenderPipelineFigureOptions = { figureId: "pipeline-one", modelElementId: "pipeline-model-one" };
const html: Promise<string> = renderPipelineFigure(model, serverOptions);
const browserOptions: MountPipelineViewerOptions = { model, details: async (nodeId): Promise<NodeDetails | string | undefined> => undefined };
const handle: Promise<PipelineViewerHandle> = mountPipelineViewer(undefined as unknown as Element, browserOptions);
void html; void handle; void viewerAssets();
// @ts-expect-error runtime overlay update is still proposed
(undefined as unknown as PipelineViewerHandle).update({});
`);
  await writeFile(join(consumer, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true, noEmit: true, skipLibCheck: false }, files: ["smoke.ts"] }, null, 2)}\n`);
  await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"], { cwd: consumer, show: true });
  console.log(JSON.stringify({ result: "pass", package: packageJson.name, version: packageJson.version, exactFiles: expectedPayload.size, sha256: hash("sha256", first.bytes), peerGraphpaper: `${graphpaperName}@${graphpaperVersion}`, checks: "payload, manifest, reproducibility, NUL, import boundary, offline packed tests, renderer, strict TypeScript" }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
