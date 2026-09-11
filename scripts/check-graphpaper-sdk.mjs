// Verify the separately packed static SDK against exact, offline-installed peers.
// The npm registry's graphpaper name is unrelated: use the committed Git pin.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sdkRoot = join(root, "packages/mission-pipeline-graphpaper");
const graphpaperRoot = join(root, "node_modules/graphpaper");
const graphpaperCommit = "89240f15c171a26009430ad7eb45eb85ac2567aa";
const scratch = await mkdtemp(join(tmpdir(), "mission-pipeline-graphpaper-check-"));

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => { stdout.push(chunk); if (options.show) process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { stderr.push(chunk); if (options.show) process.stderr.write(chunk); });
  const [code] = await once(child, "close");
  const output = Buffer.concat(stdout);
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${code}:\n${output.toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`);
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
  "mission-pipeline",
  "mission-pipeline/internal/capability",
  "mission-pipeline/internal/evidence",
  "mission-pipeline/internal/guards",
  "mission-pipeline/contracts/digest",
  "mission-pipeline/graph/definition",
  "mission-pipeline/graph/compile",
  "mission-pipeline/graph/display",
  "mission-pipeline/graph/goals"
]);

function assertImportBoundary(path, source, knownFiles) {
  const sourceRoot = join(sdkRoot, path.includes(`${sep}src${sep}`) ? "src" : "lib");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const sourceTypeScript = sourceRoot.endsWith(`${sep}src`);
  const ambientEffects = new Set(["fetch", "XMLHttpRequest", "WebSocket", "document", "window", "process", "setTimeout", "setInterval", "requestAnimationFrame", "eval", "Function"]);
  const inspect = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined) {
        assert.ok(ts.isStringLiteral(specifier), `${path}: module specifier must be literal`);
        const name = specifier.text;
        if (name === "graphpaper") {
          const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly === true;
          assert.ok(typeOnly, `${path}: graphpaper is type-only in the static core`);
        } else if (name.startsWith(".")) {
          const target = resolve(dirname(path), sourceTypeScript ? name.replace(/\.js$/, ".ts") : name);
          assert.ok(target.startsWith(`${sourceRoot}${sep}`) && knownFiles.has(target), `${path}: relative import escapes package or is missing: ${name}`);
        } else {
          assert.ok(engineImports.has(name), `${path}: import outside static core allowlist: ${name}`);
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error(`${path}: dynamic imports are outside the static core boundary`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      throw new Error(`${path}: CommonJS require is outside the static core boundary`);
    }
    if (ts.isIdentifier(node) && ambientEffects.has(node.text)) {
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
  assert.equal(packageJson.name, "mission-pipeline-graphpaper");
  assert.equal(packageJson.version, "0.1.0");
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(packageJson.optionalDependencies ?? {}, {});
  assert.deepEqual(packageJson.peerDependencies, { "mission-pipeline": "^1.1.0", graphpaper: "^0.5.0" });
  assert.deepEqual(packageJson.peerDependenciesMeta, { graphpaper: { optional: true } }, "the unrelated registry graphpaper must not be auto-installed");
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [".", "./package.json"]);

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
    "LICENSE", "README.md", "package.json",
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
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  assert.equal(rootMetadata.devDependencies.graphpaper, `git+https://github.com/scshafe/graphpaper.git#${graphpaperCommit}`);
  const lockedGraphpaper = lock.packages["node_modules/graphpaper"];
  assert.equal(lockedGraphpaper.version, "0.5.0");
  assert.match(lockedGraphpaper.resolved, new RegExp(`github\\.com[/:]scshafe/graphpaper\\.git#${graphpaperCommit}$`));
  const graphpaperMetadata = JSON.parse(await readFile(join(graphpaperRoot, "package.json"), "utf8"));
  assert.equal(graphpaperMetadata.name, "graphpaper");
  assert.equal(graphpaperMetadata.version, "0.5.0");
  assert.equal(graphpaperMetadata.exports["."].default, "./src/index.js");
  const engine = await pack(root, join(scratch, "engine"));
  const graphpaper = await pack(graphpaperRoot, join(scratch, "graphpaper"));
  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  await run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional", engine.path, first.path, graphpaper.path], { cwd: consumer, show: true });
  await cp(join(sdkRoot, "test"), join(consumer, "test"), { recursive: true });
  await cp(join(root, "test/fixtures/mission-pipeline"), join(consumer, "test/fixtures/mission-pipeline"), { recursive: true });
  const testFiles = (await walk(join(consumer, "test"))).filter((path) => path.endsWith(".test.mjs"));
  assert.ok(testFiles.length > 0, "SDK packed consumer must run at least one test suite");
  await run(process.execPath, ["--test", ...testFiles], { cwd: consumer, show: true });

  await writeFile(join(consumer, "smoke.mjs"), `
import assert from "node:assert/strict";
import { compileGraph, projectGraphDisplay } from "mission-pipeline";
import { buildPipelineDiagram, pipelineLegend, PIPELINE_RENDER_OPTIONS, PIPELINE_PRESENTATION_SCHEMA_VERSION } from "mission-pipeline-graphpaper";
import { layoutDiagram, renderDiagramSvg } from "graphpaper";
import { SUPPORT_TRIAGE_GRAPH, SUPPORT_TRIAGE_PRESENTATION, SUPPORT_TRIAGE_GOAL_MANIFEST } from "./test/fixtures/mission-pipeline/support-triage-example.mjs";
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
`);
  await run(process.execPath, ["smoke.mjs"], { cwd: consumer, show: true });

  await writeFile(join(consumer, "smoke.ts"), `
import { buildPipelineDiagram, validatePresentation, pipelineLegend, PIPELINE_RENDER_OPTIONS, PIPELINE_PRESENTATION_SCHEMA_VERSION, type PipelinePresentation, type BuildPipelineDiagramInput, type PipelineDiagramMetadata } from "mission-pipeline-graphpaper";
import type { GraphDisplayProjection, GraphDefinition, GoalManifest } from "mission-pipeline";
import type { DiagramModel, DiagramLegendEntry, DiagramRenderOptions } from "graphpaper";
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
`);
  await writeFile(join(consumer, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true, noEmit: true, skipLibCheck: false }, files: ["smoke.ts"] }, null, 2)}\n`);
  await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"], { cwd: consumer, show: true });
  console.log(JSON.stringify({ result: "pass", package: packageJson.name, version: packageJson.version, exactFiles: expectedPayload.size, sha256: hash("sha256", first.bytes), peerGraphpaper: `0.5.0@${graphpaperCommit}`, checks: "payload, manifest, reproducibility, NUL, import boundary, offline packed tests, renderer, strict TypeScript" }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
