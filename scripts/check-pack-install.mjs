import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), "mission-pipeline-pack-"));

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit"
  });
  let stdout = "";
  if (options.capture) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
  }
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}`);
  return stdout;
}

try {
  const packed = JSON.parse(await run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    scratch
  ], { capture: true }));
  if (packed.length !== 1 || typeof packed[0].filename !== "string") {
    throw new Error("npm pack did not return one tarball");
  }

  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`
  );
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(scratch, packed[0].filename)
  ], { cwd: consumer });

  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const smoke = `
    import * as root from "mission-pipeline";
    import { createGraphDefinition } from "mission-pipeline/graph/definition";
    import { compileGraph } from "mission-pipeline/graph/compile";
    import { projectGraphDisplay } from "mission-pipeline/graph/display";
    import { graphDefinitionDiff } from "mission-pipeline/graph/diff";
    import { createJoinInputArtifact, validateJoinInputArtifact } from "mission-pipeline/store/join-input";
    import { withDeclaredFailureOutcomes } from "mission-pipeline/execute/declared-failures";
    import { nodeTurnIdempotencyKey } from "mission-pipeline/execute/turn";
    import { runClaimedUnitTurn } from "mission-pipeline/execute/unit-runner";
    import { validateModelStageBinding } from "mission-pipeline/model/binding";
    import { AGENT_STEP_REQUEST_SCHEMA_VERSION } from "mission-pipeline/agent/step";
    import { compileGateFlow } from "mission-pipeline/gate/compiler";
    import metadata from "mission-pipeline/package.json" with { type: "json" };

    const graph = createGraphDefinition({
      graphId: "install.smoke",
      version: 1,
      description: "Packed graph smoke.",
      entry: "only",
      nodes: [{
        nodeId: "only",
        ref: { id: "smoke.only", version: 1 },
        kind: "code",
        input: "smoke-input.v1",
        outcomes: { version: 1, outcomes: ["done"] },
        principal: { id: "worker" },
        turn: {
          idempotency: "per (unitId, nodeId, attemptNumber)",
          leaseMs: 1_000,
          maxAttempts: 1,
          retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
        }
      }],
      edges: [],
      terminals: [{ nodeId: "only", outcome: "done" }]
    });
    if (compileGraph(graph).graph.digest !== graph.graphDigest) {
      throw new Error("packed graph compile mismatch");
    }
    if (root.compileGraph !== compileGraph || typeof runClaimedUnitTurn !== "function") {
      throw new Error("v2 root export mismatch");
    }
    const display = projectGraphDisplay(compileGraph(graph));
    const diff = graphDefinitionDiff(graph, graph);
    if (display.graph.digest !== graph.graphDigest || !diff.empty
      || diff.sealed.digest !== graph.graphDigest || diff.candidate.digest !== graph.graphDigest
      || root.projectGraphDisplay !== projectGraphDisplay || root.graphDefinitionDiff !== graphDefinitionDiff
      || "requireCompiledGraph" in root) {
      throw new Error("packed graph projection export or identity mismatch");
    }
    if (typeof nodeTurnIdempotencyKey !== "function" || typeof validateModelStageBinding !== "function") {
      throw new Error("v2 execution/model export missing");
    }
    if (root.createJoinInputArtifact !== createJoinInputArtifact
      || root.validateJoinInputArtifact !== validateJoinInputArtifact
      || root.withDeclaredFailureOutcomes !== withDeclaredFailureOutcomes
      || root.JOIN_INPUT_ARTIFACT_CONTRACT !== "mission-pipeline.join-input.v1"
      || "declaredFailureRecoveryUsage" in root || "isDeclaredFailureUnresolved" in root) {
      throw new Error("P7/P8 public export boundary mismatch");
    }
    if (AGENT_STEP_REQUEST_SCHEMA_VERSION !== "agent-step-request.v1" || typeof compileGateFlow !== "function") {
      throw new Error("agent/gate helper export missing");
    }
    if (metadata.version !== ${JSON.stringify(packageJson.version)}) {
      throw new Error("package version mismatch");
    }

    const retiredRootNames = [
      ["compile", "Pipeline"].join(""),
      ["Pipeline", "Store"].join(""),
      ["run", "One", "Shard"].join("")
    ];
    for (const name of retiredRootNames) {
      if (name in root) throw new Error("retired root export present: " + name);
    }
    const retiredSubpaths = [
      "compile",
      "definition",
      "catalog",
      "memory-store",
      "store",
      ["execute", "shard-runner"].join("/"),
      ["execute", "durable-stage"].join("/"),
      ["gate", "executor"].join("/")
    ];
    for (const subpath of retiredSubpaths) {
      try {
        await import("mission-pipeline/" + subpath);
        throw new Error("retired subpath resolved: " + subpath);
      } catch (error) {
        if (String(error?.message).startsWith("retired subpath resolved:")) throw error;
      }
    }
  `;
  await writeFile(join(consumer, "smoke.mjs"), smoke);
  await run("node", ["smoke.mjs"], { cwd: consumer });

  const typeSmoke = `
    import {
      GRAPH_VALIDATION_LIMITS,
      compileGraph,
      createGraphDefinition,
      projectGraphDisplay,
      graphDefinitionDiff,
      createJoinInputArtifact,
      validateJoinInputArtifact,
      withDeclaredFailureOutcomes,
      JOIN_INPUT_ARTIFACT_CONTRACT,
      type JoinInputPayload,
      type DeclaredFailureModelPort,
      nodeExecutionFingerprint,
      nodeTurnIdempotencyKey,
      recordHumanNodeDecision,
      runClaimedUnitTurn,
      runNextUnitTurns,
      validateNodeTurnCompletion,
      type CompiledGraph,
      type GraphDefinition,
      type GraphDefinitionDraft,
      type GraphDisplayProjection,
      type GraphDefinitionDiff,
      type MissionPipelineNode,
      type ModelBindingResolver,
      type OutcomePredicate,
      type OutcomeVocabulary,
      type TurnExecutionStore,
      type TurnRunnerStore,
      type WorkerNodeTurnContext
    } from "mission-pipeline";
    import type { UnitStore } from "mission-pipeline/store/unit-store";
    import type { ModelInvocationRequest } from "mission-pipeline/model/invoker";
    import type { AgentStepExecutor } from "mission-pipeline/agent/executor-port";

    const exported = {
      compileGraph,
      createGraphDefinition,
      nodeExecutionFingerprint,
      nodeTurnIdempotencyKey,
      recordHumanNodeDecision,
      runClaimedUnitTurn,
      runNextUnitTurns,
      validateNodeTurnCompletion
    };
    const draft = undefined as unknown as GraphDefinitionDraft;
    const graph = undefined as unknown as GraphDefinition;
    const compiled = undefined as unknown as CompiledGraph;
    const display: GraphDisplayProjection = projectGraphDisplay(compiled);
    const diff: GraphDefinitionDiff = graphDefinitionDiff(graph, graph);
    const joinInput: JoinInputPayload = validateJoinInputArtifact(graph,
      createJoinInputArtifact(graph, { unitId: "fixture", nodeId: "join", accepted: [] })).payload;
    const modelFailurePort = undefined as unknown as DeclaredFailureModelPort;
    // @ts-expect-error model failure recovery requires an explicit receipt policy
    withDeclaredFailureOutcomes(modelFailurePort, { kind: "model", outcomes: {}, artifact: () => { throw new Error("fixture"); } });
    // @ts-expect-error composition is a closed optional vocabulary
    const wrongJoin: import("mission-pipeline").MissionPipelineJoin = { inbound: ["edge"], require: "all", compose: "merge" };
    void joinInput;
    void JOIN_INPUT_ARTIFACT_CONTRACT;
    const node = undefined as unknown as MissionPipelineNode;
    const outcomes = undefined as unknown as OutcomeVocabulary;
    const predicate = undefined as unknown as OutcomePredicate;
    const store = undefined as unknown as UnitStore;
    const runnerStore = undefined as unknown as TurnRunnerStore;
    const executionStore = undefined as unknown as TurnExecutionStore;
    const context = undefined as unknown as WorkerNodeTurnContext;
    const resolver = undefined as unknown as ModelBindingResolver;
    const request = undefined as unknown as ModelInvocationRequest;
    const executor = undefined as unknown as AgentStepExecutor;
    // @ts-expect-error sealed graph arrays are readonly
    graph.nodes.push(node);
    // @ts-expect-error display topology is readonly
    display.nodes[0].depth = 1;
    // @ts-expect-error definition diff arrays are readonly
    diff.nodes.pop();
    // @ts-expect-error node bodies receive no store capability
    context.store.prepareTurnAttempt({});
    // @ts-expect-error execution stores cannot admit units
    executionStore.admitUnit({});
    void exported;
    void draft;
    void compiled;
    void outcomes;
    void predicate;
    void store;
    void runnerStore;
    void resolver;
    void request;
    void executor;
    void GRAPH_VALIDATION_LIMITS;
  `;
  await writeFile(join(consumer, "smoke.ts"), typeSmoke);
  await writeFile(join(consumer, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2022",
      strict: true,
      noEmit: true,
      skipLibCheck: false
    },
    files: ["smoke.ts"]
  }, null, 2)}\n`);
  await run(process.execPath, [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--project",
    "tsconfig.json"
  ], { cwd: consumer });
  console.log("Mission Pipeline packed-install runtime + TypeScript smoke passed.");
} finally {
  await rm(scratch, { force: true, recursive: true });
}
