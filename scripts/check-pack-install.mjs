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
    'import { compilePipeline, validateCompiledPipelineNode } from "mission-pipeline/compile";',
    'import { createPipelineDefinition } from "mission-pipeline/definition";',
    'import { validateOutcomeVocabulary } from "mission-pipeline/graph/outcome";',
    'import { validateEdge } from "mission-pipeline/graph/edge";',
    'import { createGraphDefinition } from "mission-pipeline/graph/definition";',
    'import { compileGraph } from "mission-pipeline/graph/compile";',
    'import { MAX_GRAPH_VALIDATION_DEPTH } from "mission-pipeline/graph/limits";',
    'import { createGateTerminationCertificate } from "mission-pipeline/gate/certificate";',
    'import { AGENT_STEP_REQUEST_SCHEMA_VERSION } from "mission-pipeline/agent/step";',
    'import { createRetrySafeOutboxEvents, combineOutboxEvents } from "mission-pipeline/execute/outbox";',
    'import { classifyExecutionFailure } from "mission-pipeline/execute/failure";',
    'import { validateNodeTurnCompletion } from "mission-pipeline/execute/ports";',
    'import { nodeExecutionFingerprint, nodeTurnIdempotencyKey } from "mission-pipeline/execute/turn";',
    'import { runClaimedUnitTurn, runNextUnitTurns, recordHumanNodeDecision, admitCallbackNodeEvent } from "mission-pipeline/execute/unit-runner";',
    'import { StageEvidenceAssemblyError, OutboxEvidenceNotCommittedError, StageResultConflictError, executeBoundDurableStage } from "mission-pipeline/execute/durable-stage";',
    'import { createBoundPipelineExecutionIdentity, validateBoundPipelineExecutionIdentity, runBoundShard, executeClaimedShard, runWithShardHeartbeat, snapshotNodeInvocation } from "mission-pipeline/execute/shard-runner";',
    'import { BoundEvidencePersistenceError, EvidenceConflictError, ShardSettlementUncertainError, outboxEventDigest } from "mission-pipeline/store";',
    'import schema from "mission-pipeline/schemas/pipeline-definition.v2.schema.json" with { type: "json" };',
    'import metadata from "mission-pipeline/package.json" with { type: "json" };',
    "if (root.compilePipeline !== compilePipeline) throw new Error('root compiler export mismatch');",
    "if (root.compileGraph !== compileGraph) throw new Error('root graph compiler export mismatch');",
    "if (typeof createPipelineDefinition !== 'function') throw new Error('definition export missing');",
    "if (typeof createGraphDefinition !== 'function' || typeof validateOutcomeVocabulary !== 'function' || typeof validateEdge !== 'function') throw new Error('graph exports missing');",
    "if (MAX_GRAPH_VALIDATION_DEPTH !== 16) throw new Error('graph limits export missing');",
    'const graph = createGraphDefinition({graphId:"install.smoke",version:1,description:"Packed graph smoke.",entry:"only",nodes:[{nodeId:"only",ref:{id:"smoke.only",version:1},kind:"code",input:"smoke-input.v1",outcomes:{version:1,outcomes:["done"]},principal:{id:"v2_worker"},turn:{idempotency:"per (unitId, nodeId, attemptNumber)",leaseMs:1000,maxAttempts:1,retryTaxonomy:"retryable vs terminal, as v1 durable-stage"}}],edges:[],terminals:[{nodeId:"only",outcome:"done"}]});',
    "if (compileGraph(graph).graph.digest !== graph.graphDigest) throw new Error('packed graph compile mismatch');",
    "if (typeof validateCompiledPipelineNode !== 'function') throw new Error('compiled-node validator export missing');",
    "if (typeof createGateTerminationCertificate !== 'function') throw new Error('gate export missing');",
    "if (AGENT_STEP_REQUEST_SCHEMA_VERSION !== 'agent-step-request.v1') throw new Error('agent export mismatch');",
    "if (typeof createRetrySafeOutboxEvents !== 'function' || typeof combineOutboxEvents !== 'function') throw new Error('outbox exports missing');",
    "if (typeof classifyExecutionFailure !== 'function' || typeof validateNodeTurnCompletion !== 'function') throw new Error('node turn port exports missing');",
    "if (typeof nodeExecutionFingerprint !== 'function' || typeof nodeTurnIdempotencyKey !== 'function') throw new Error('node turn identity exports missing');",
    "if (typeof runClaimedUnitTurn !== 'function' || typeof runNextUnitTurns !== 'function' || typeof recordHumanNodeDecision !== 'function' || typeof admitCallbackNodeEvent !== 'function') throw new Error('unit runner exports missing');",
    "if ('NodeTurnResultError' in root || 'NodeTurnInvocationUncertainError' in root) throw new Error('internal node-turn error constructor leaked');",
    "if (typeof StageEvidenceAssemblyError !== 'function' || typeof OutboxEvidenceNotCommittedError !== 'function' || typeof StageResultConflictError !== 'function' || typeof executeBoundDurableStage !== 'function') throw new Error('durable evidence exports missing');",
    "if (typeof createBoundPipelineExecutionIdentity !== 'function' || typeof validateBoundPipelineExecutionIdentity !== 'function') throw new Error('bound identity exports missing');",
    "if (typeof runBoundShard !== 'function' || executeClaimedShard !== runBoundShard || typeof runWithShardHeartbeat !== 'function' || typeof snapshotNodeInvocation !== 'function') throw new Error('runner exports missing');",
    "if (typeof BoundEvidencePersistenceError !== 'function' || typeof EvidenceConflictError !== 'function' || typeof ShardSettlementUncertainError !== 'function' || typeof outboxEventDigest !== 'function') throw new Error('store evidence exports missing');",
    "if (schema.$id !== 'https://mission-pipeline.local/pipeline-definition.v2.schema.json') throw new Error('schema export mismatch');",
    `if (metadata.version !== ${JSON.stringify(packageJson.version)}) throw new Error('package version mismatch');`
  ].join("\n");
  await writeFile(join(consumer, "smoke.mjs"), `${smoke}\n`);
  await run("node", ["smoke.mjs"], { cwd: consumer });
  const typeSmoke = `
    import { GRAPH_VALIDATION_LIMITS } from "mission-pipeline/graph/limits";
    import type { OutcomeVocabulary as DirectOutcomeVocabulary } from "mission-pipeline/graph/outcome";
    import type { OutcomePredicate as DirectOutcomePredicate } from "mission-pipeline/graph/edge";
    import type {
      GraphDefinition as DirectGraphDefinition,
      MissionPipelineNode as DirectMissionPipelineNode
    } from "mission-pipeline/graph/definition";
    import type { CompiledGraph as DirectCompiledGraph } from "mission-pipeline/graph/compile";
    import {
      BoundEvidencePersistenceError,
      EvidenceConflictError,
      OutboxEvidenceNotCommittedError,
      ShardSettlementUncertainError,
      StageEvidenceAssemblyError,
      StageResultConflictError,
      combineOutboxEvents,
      classifyExecutionFailure,
      compileGraph,
      createGraphDefinition,
      createBoundPipelineExecutionIdentity,
      createRetrySafeOutboxEvents,
      executeBoundDurableStage,
      executeClaimedShard,
      admitCallbackNodeEvent,
      nodeExecutionFingerprint,
      nodeTurnIdempotencyKey,
      outboxEventDigest,
      recordHumanNodeDecision,
      runClaimedUnitTurn,
      runNextUnitTurns,
      runBoundShard,
      runWithShardHeartbeat,
      snapshotNodeInvocation,
      validateCompiledPipelineNode,
      validateNodeTurnCompletion,
      validateEdge,
      validateGraphDefinition,
      validateOutcomeVocabulary,
      validateBoundPipelineExecutionIdentity,
      type BoundPipelineExecutionIdentity,
      type BoundPipelineShard,
      type BoundDurableStageInput,
      type CompiledGraph,
      type GraphDefinition,
      type GraphDefinitionDraft,
      type MissionPipelineNode,
      type OutcomePredicate,
      type OutcomeVocabulary,
      type OutboxEvents,
      type RetrySafeOutboxEvents,
      type TurnExecutionStore,
      type TurnRunnerStore,
      type WorkerTurnRunnerStore,
      type ExternalTurnRunnerStore,
      type WorkerNodeTurnContext
    } from "mission-pipeline";

    const exported = {
      BoundEvidencePersistenceError,
      EvidenceConflictError,
      OutboxEvidenceNotCommittedError,
      ShardSettlementUncertainError,
      StageEvidenceAssemblyError,
      StageResultConflictError,
      combineOutboxEvents,
      classifyExecutionFailure,
      compileGraph,
      createGraphDefinition,
      createBoundPipelineExecutionIdentity,
      createRetrySafeOutboxEvents,
      executeBoundDurableStage,
      executeClaimedShard,
      admitCallbackNodeEvent,
      nodeExecutionFingerprint,
      nodeTurnIdempotencyKey,
      outboxEventDigest,
      recordHumanNodeDecision,
      runClaimedUnitTurn,
      runNextUnitTurns,
      runBoundShard,
      runWithShardHeartbeat,
      snapshotNodeInvocation,
      validateCompiledPipelineNode,
      validateNodeTurnCompletion,
      validateEdge,
      validateGraphDefinition,
      validateOutcomeVocabulary,
      validateBoundPipelineExecutionIdentity
    };
    const events: OutboxEvents = [];
    const retrySafe: RetrySafeOutboxEvents = createRetrySafeOutboxEvents([], () => {});
    const identity = undefined as unknown as BoundPipelineExecutionIdentity;
    const directInput = undefined as unknown as BoundDurableStageInput<{ generation: number }>;
    const directShard: BoundPipelineShard = directInput.shard;
    const graphDraft = undefined as unknown as GraphDefinitionDraft;
    const graph = undefined as unknown as GraphDefinition;
    const compiledGraph = undefined as unknown as CompiledGraph;
    const graphNode = undefined as unknown as MissionPipelineNode;
    const outcomes = undefined as unknown as OutcomeVocabulary;
    const predicate = undefined as unknown as OutcomePredicate;
    const directOutcomes = undefined as unknown as DirectOutcomeVocabulary;
    const directPredicate = undefined as unknown as DirectOutcomePredicate;
    const directGraph = undefined as unknown as DirectGraphDefinition;
    const directNode = undefined as unknown as DirectMissionPipelineNode;
    const directCompiled = undefined as unknown as DirectCompiledGraph;
    const turnStore = undefined as unknown as TurnRunnerStore;
    const executionStore = undefined as unknown as TurnExecutionStore;
    const workerTurnStore = undefined as unknown as WorkerTurnRunnerStore;
    const externalTurnStore = undefined as unknown as ExternalTurnRunnerStore;
    const workerContext = undefined as unknown as WorkerNodeTurnContext;
    // @ts-expect-error sealed graph arrays are readonly in the public contract
    graph.nodes.push(graphNode);
    // @ts-expect-error sealed node fields are readonly in the public contract
    graphNode.kind = "code";
    // @ts-expect-error sealed outcome arrays are readonly in the public contract
    outcomes.outcomes.push("late");
    // @ts-expect-error compiled graph properties are readonly in the public contract
    compiledGraph.entry = "late";
    // @ts-expect-error node bodies receive no store or admission capability
    workerContext.store.prepareTurnAttempt({});
    // @ts-expect-error the execution-side store seam cannot admit units
    executionStore.admitUnit({});
    // @ts-expect-error worker claims do not grant external inspection authority
    workerTurnStore.inspectExternalUnitTurn({});
    // @ts-expect-error external completion does not grant worker claim authority
    externalTurnStore.claimUnitTurns({});
    void exported;
    void events;
    void retrySafe;
    void identity;
    void directShard;
    void graphDraft;
    void graph;
    void compiledGraph;
    void graphNode;
    void outcomes;
    void predicate;
    void GRAPH_VALIDATION_LIMITS;
    void directOutcomes;
    void directPredicate;
    void directGraph;
    void directNode;
    void directCompiled;
    void turnStore;
    void executionStore;
    void workerTurnStore;
    void externalTurnStore;
    void workerContext;
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
