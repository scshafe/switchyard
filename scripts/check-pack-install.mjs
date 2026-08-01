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
    'import { createRetrySafeOutboxEvents, combineOutboxEvents } from "mission-pipeline/execute/outbox";',
    'import { StageEvidenceAssemblyError, OutboxEvidenceNotCommittedError, StageResultConflictError } from "mission-pipeline/execute/durable-stage";',
    'import { createBoundPipelineExecutionIdentity, validateBoundPipelineExecutionIdentity, runBoundShard, executeClaimedShard, runWithShardHeartbeat } from "mission-pipeline/execute/shard-runner";',
    'import { BoundEvidencePersistenceError, EvidenceConflictError, outboxEventDigest } from "mission-pipeline/store";',
    'import schema from "mission-pipeline/schemas/pipeline-definition.v2.schema.json" with { type: "json" };',
    'import metadata from "mission-pipeline/package.json" with { type: "json" };',
    "if (root.compilePipeline !== compilePipeline) throw new Error('root compiler export mismatch');",
    "if (typeof createPipelineDefinition !== 'function') throw new Error('definition export missing');",
    "if (typeof createGateTerminationCertificate !== 'function') throw new Error('gate export missing');",
    "if (AGENT_STEP_REQUEST_SCHEMA_VERSION !== 'agent-step-request.v1') throw new Error('agent export mismatch');",
    "if (typeof createRetrySafeOutboxEvents !== 'function' || typeof combineOutboxEvents !== 'function') throw new Error('outbox exports missing');",
    "if (typeof StageEvidenceAssemblyError !== 'function' || typeof OutboxEvidenceNotCommittedError !== 'function' || typeof StageResultConflictError !== 'function') throw new Error('durable evidence errors missing');",
    "if (typeof createBoundPipelineExecutionIdentity !== 'function' || typeof validateBoundPipelineExecutionIdentity !== 'function') throw new Error('bound identity exports missing');",
    "if (typeof runBoundShard !== 'function' || executeClaimedShard !== runBoundShard || typeof runWithShardHeartbeat !== 'function') throw new Error('runner exports missing');",
    "if (typeof BoundEvidencePersistenceError !== 'function' || typeof EvidenceConflictError !== 'function' || typeof outboxEventDigest !== 'function') throw new Error('store evidence exports missing');",
    "if (schema.$id !== 'https://mission-pipeline.local/pipeline-definition.v2.schema.json') throw new Error('schema export mismatch');",
    `if (metadata.version !== ${JSON.stringify(packageJson.version)}) throw new Error('package version mismatch');`
  ].join("\n");
  await writeFile(join(consumer, "smoke.mjs"), `${smoke}\n`);
  await run("node", ["smoke.mjs"], { cwd: consumer });
  const typeSmoke = `
    import {
      BoundEvidencePersistenceError,
      EvidenceConflictError,
      OutboxEvidenceNotCommittedError,
      StageEvidenceAssemblyError,
      StageResultConflictError,
      combineOutboxEvents,
      createBoundPipelineExecutionIdentity,
      createRetrySafeOutboxEvents,
      executeClaimedShard,
      outboxEventDigest,
      runBoundShard,
      runWithShardHeartbeat,
      validateBoundPipelineExecutionIdentity,
      type BoundPipelineExecutionIdentity,
      type OutboxEvents,
      type RetrySafeOutboxEvents
    } from "mission-pipeline";

    const exported = {
      BoundEvidencePersistenceError,
      EvidenceConflictError,
      OutboxEvidenceNotCommittedError,
      StageEvidenceAssemblyError,
      StageResultConflictError,
      combineOutboxEvents,
      createBoundPipelineExecutionIdentity,
      createRetrySafeOutboxEvents,
      executeClaimedShard,
      outboxEventDigest,
      runBoundShard,
      runWithShardHeartbeat,
      validateBoundPipelineExecutionIdentity
    };
    const events: OutboxEvents = [];
    const retrySafe: RetrySafeOutboxEvents = createRetrySafeOutboxEvents([], () => {});
    const identity = undefined as unknown as BoundPipelineExecutionIdentity;
    void exported;
    void events;
    void retrySafe;
    void identity;
  `;
  await writeFile(join(consumer, "smoke.ts"), typeSmoke);
  await writeFile(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        skipLibCheck: false
      },
      files: ["smoke.ts"]
    }, null, 2)}\n`
  );
  await run(
    process.execPath,
    [resolve(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"],
    { cwd: consumer }
  );
  console.log("Mission Pipeline packed-install runtime + TypeScript smoke passed.");
} finally {
  await rm(scratch, { force: true, recursive: true });
}
