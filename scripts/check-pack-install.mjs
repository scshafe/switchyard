import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), "mission-pipeline-pack-"));

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: options.capture
      ? ["ignore", "pipe", "inherit"]
      : "inherit"
  });
  let stdout = "";
  if (options.capture) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
  }
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${code}`);
  }
  return stdout;
}

try {
  const packed = JSON.parse(
    await run(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        scratch
      ],
      { capture: true }
    )
  );
  if (packed.length !== 1 || typeof packed[0].filename !== "string") {
    throw new Error("npm pack did not return one tarball");
  }

  const tarball = join(scratch, packed[0].filename);
  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`
  );
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball
    ],
    { cwd: consumer }
  );

  const packageJson = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8")
  );
  const smoke = [
    'import * as root from "mission-pipeline";',
    'import { compilePipeline } from "mission-pipeline/compile";',
    'import { createPipelineDefinition } from "mission-pipeline/definition";',
    'import { createGateTerminationCertificate } from "mission-pipeline/gate/certificate";',
    'import { AGENT_STEP_REQUEST_SCHEMA_VERSION } from "mission-pipeline/agent/step";',
    'import schema from "mission-pipeline/schemas/pipeline-definition.v2.schema.json" with { type: "json" };',
    'import metadata from "mission-pipeline/package.json" with { type: "json" };',
    "if (root.compilePipeline !== compilePipeline) throw new Error('root compiler export mismatch');",
    "if (typeof createPipelineDefinition !== 'function') throw new Error('definition export missing');",
    "if (typeof createGateTerminationCertificate !== 'function') throw new Error('gate export missing');",
    "if (AGENT_STEP_REQUEST_SCHEMA_VERSION !== 'agent-step-request.v1') throw new Error('agent export mismatch');",
    "if (schema.$id !== 'https://mission-pipeline.local/pipeline-definition.v2.schema.json') throw new Error('schema export mismatch');",
    `if (metadata.version !== ${JSON.stringify(packageJson.version)}) throw new Error('package version mismatch');`
  ].join("\n");
  await writeFile(join(consumer, "smoke.mjs"), `${smoke}\n`);
  await run("node", ["smoke.mjs"], { cwd: consumer });
  console.log("Mission Pipeline packed-install smoke passed.");
} finally {
  await rm(scratch, { force: true, recursive: true });
}
