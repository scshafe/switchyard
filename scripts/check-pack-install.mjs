import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNPM_PACK_ARGS, singlePackReport } from "./release-identity.mjs";

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
  const packed = singlePackReport(await run("pnpm", [
    ...PNPM_PACK_ARGS,
    "--pack-destination",
    scratch
  ], { capture: true }));

  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`
  );
  await run("pnpm", [
    "add",
    "--ignore-scripts",
    "--offline",
    join(scratch, packed.basename)
  ], { cwd: consumer });

  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const smoke = `
    import * as root from "@scshafe/mission-pipeline";
    import { createGraphDefinition } from "@scshafe/mission-pipeline/graph/definition";
    import { compileGraph } from "@scshafe/mission-pipeline/graph/compile";
    import { nodeTurnIdempotencyKey } from "@scshafe/mission-pipeline/execute/turn";
    import { runClaimedUnitTurn } from "@scshafe/mission-pipeline/execute/unit-runner";
    import { validateModelStageBinding } from "@scshafe/mission-pipeline/model/binding";
    import { AGENT_STEP_REQUEST_SCHEMA_VERSION } from "@scshafe/mission-pipeline/agent/step";
    import { compileGateFlow } from "@scshafe/mission-pipeline/gate/compiler";
    import metadata from "@scshafe/mission-pipeline/package.json" with { type: "json" };

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
    if (typeof nodeTurnIdempotencyKey !== "function" || typeof validateModelStageBinding !== "function") {
      throw new Error("v2 execution/model export missing");
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
        await import("@scshafe/mission-pipeline/" + subpath);
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
      nodeExecutionFingerprint,
      nodeTurnIdempotencyKey,
      recordHumanNodeDecision,
      runClaimedUnitTurn,
      runNextUnitTurns,
      validateNodeTurnCompletion,
      type CompiledGraph,
      type GraphDefinition,
      type GraphDefinitionDraft,
      type MissionPipelineNode,
      type ModelBindingResolver,
      type OutcomePredicate,
      type OutcomeVocabulary,
      type TurnExecutionStore,
      type TurnRunnerStore,
      type WorkerNodeTurnContext
    } from "@scshafe/mission-pipeline";
    import type { UnitStore } from "@scshafe/mission-pipeline/store/unit-store";
    import type { ModelInvocationRequest } from "@scshafe/mission-pipeline/model/invoker";
    import type { AgentStepExecutor } from "@scshafe/mission-pipeline/agent/executor-port";

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
