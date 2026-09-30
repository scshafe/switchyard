import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { projectRoot, readReleaseIdentity } from "./release-identity.mjs";

// The current release manifest path and version come from the project's own
// package.json, never from a hardcoded literal (probe roots reuse them).
const projectRelease = await readReleaseIdentity(projectRoot);
const root = process.env.SWITCHYARD_V1_GUARD_PROBE_ROOT === undefined
  ? projectRoot
  : resolve(process.env.SWITCHYARD_V1_GUARD_PROBE_ROOT);
const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);

const forbiddenPaths = [
  "docs/examples/branch-and-join-pipeline.md",
  "docs/examples/branch-and-join-pipeline.mjs",
  "docs/examples/linear-code-pipeline.md",
  "docs/examples/linear-code-pipeline.mjs",
  "release/mission-pipeline-0.2.0.payload.sha256",
  "schemas/pipeline-definition.v2.schema.json",
  "schemas/stage-descriptor.v1.schema.json",
  "sql/reference/pipeline-store.sql",
  "scripts/check-postgres-reference.mjs",
  "src/catalog.ts",
  "src/compile.ts",
  "src/definition.ts",
  "src/execute/control.ts",
  "src/execute/durable-stage.ts",
  "src/execute/outbox.ts",
  "src/execute/shard-runner.ts",
  "src/gate/executor.ts",
  "src/internal/outbox.ts",
  "src/memory-store.ts",
  "src/node.ts",
  "src/store.ts",
  "test/switchyard-bound-runner.test.mjs",
  "test/switchyard-durable.test.mjs",
  "test/switchyard-node-model.test.mjs",
  "test/reference-ddl.test.mjs"
];

const requiredPaths = [
  "src/graph/compile.ts",
  "src/execute/failure.ts",
  "src/execute/ports.ts",
  "src/execute/turn.ts",
  "src/execute/unit-runner.ts",
  "src/store/graph-store.ts",
  "src/store/unit-store.ts",
  projectRelease.manifest
];

const forbiddenSymbols = [
  ["Pipeline", "Definition"].join(""),
  ["compile", "Pipeline"].join(""),
  ["Compiled", "Pipeline"].join(""),
  ["Pipeline", "Store"].join(""),
  ["Memory", "Pipeline", "Store"].join(""),
  ["run", "One", "Shard"].join(""),
  ["run", "Bound", "Shard"].join(""),
  ["execute", "Claimed", "Shard"].join(""),
  ["execute", "Bound", "Durable", "Stage"].join(""),
  ["Shard", "Runner"].join(""),
  ["Stage", "Catalog"].join("")
];

async function exists(path) {
  try {
    await access(resolve(root, path));
    return true;
  } catch {
    return false;
  }
}

const failures = [];
for (const path of forbiddenPaths) {
  if (await exists(path)) failures.push(`retired path still exists: ${path}`);
}
for (const path of requiredPaths) {
  if (!(await exists(path))) failures.push(`v2 path is missing: ${path}`);
}

const scanRoots = ["README.md", "docs/README.md", "scripts", "src", "test"];
const scanExtensions = new Set([".js", ".mjs", ".ts", ".md"]);
const self = "scripts/check-v1-deletion.mjs";

async function filesUnder(path) {
  const absolute = resolve(root, path);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(relative(root, child)));
    } else if (entry.isFile()) {
      files.push(relative(root, child).split(sep).join("/"));
    }
  }
  return files;
}

async function writeProbeFile(probeRoot, path, source = "") {
  const absolute = resolve(probeRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, source, "utf8");
}

async function runProbe(probeRoot) {
  return execFileAsync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      SWITCHYARD_V1_GUARD_PROBE_ROOT: probeRoot
    }
  });
}

async function makeProbeRoot() {
  const probeRoot = await mkdtemp(join(tmpdir(), "switchyard-v1-deletion-"));
  for (const path of requiredPaths) await writeProbeFile(probeRoot, path);
  await writeProbeFile(
    probeRoot,
    "package.json",
    `${JSON.stringify({ version: projectRelease.version })}\n`
  );
  await runProbe(probeRoot);
  return probeRoot;
}

async function proveFamily(name, expected, mutate) {
  const probeRoot = await makeProbeRoot();
  try {
    await mutate(probeRoot);
    let rejection;
    try {
      await runProbe(probeRoot);
    } catch (error) {
      rejection = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${String(error)}`;
    }
    if (rejection === undefined) {
      throw new Error(`v1 deletion guard ${name} prove-it-bites fixture was accepted`);
    }
    if (!rejection.includes(expected)) {
      throw new Error(
        `v1 deletion guard ${name} proof failed for the wrong reason:\n${rejection}`
      );
    }
    console.log(`Switchyard v1 deletion guard prove-it-bites rejected ${name} family.`);
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

for (const scanRoot of scanRoots) {
  if (!(await exists(scanRoot))) continue;
  const candidates = scanRoot.includes(".")
    ? [scanRoot]
    : await filesUnder(scanRoot);
  for (const path of candidates) {
    if (path === self || !scanExtensions.has(path.slice(path.lastIndexOf(".")))) {
      continue;
    }
    const source = await readFile(resolve(root, path), "utf8");
    for (const symbol of forbiddenSymbols) {
      if (source.includes(symbol)) {
        failures.push(`retired public symbol ${symbol} remains in ${path}`);
      }
    }
  }
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const major = Number.parseInt(String(packageJson.version).split(".")[0], 10);
if (!Number.isSafeInteger(major) || major < 1) {
  failures.push(`package version must be major-versioned after v1 deletion (got ${packageJson.version})`);
}

if (failures.length > 0) {
  throw new Error(`v1 deletion guard failed:\n${failures.join("\n")}`);
}

if (root === projectRoot) {
  await proveFamily("retired-path", "retired path still exists: src/compile.ts", async (probeRoot) => {
    await writeProbeFile(probeRoot, "src/compile.ts", "export {};\n");
  });
  await proveFamily("retired-symbol", "retired public symbol compilePipeline", async (probeRoot) => {
    await writeProbeFile(
      probeRoot,
      "src/probe.ts",
      "export const retired = 'compilePipeline';\n"
    );
  });
  await proveFamily("required-v2-path", "v2 path is missing: src/graph/compile.ts", async (probeRoot) => {
    await rm(resolve(probeRoot, "src/graph/compile.ts"));
  });
  await proveFamily("major-version", "package version must be major-versioned", async (probeRoot) => {
    await writeProbeFile(
      probeRoot,
      "package.json",
      `${JSON.stringify({ version: "0.9.0" })}\n`
    );
  });
}

console.log(
  `Switchyard v1 deletion guard passed (${forbiddenPaths.length} retired paths, ${forbiddenSymbols.length} retired symbols${root === projectRoot ? ", 4 prove-it-bites families" : ""}).`
);
