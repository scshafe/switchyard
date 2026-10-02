// Packed-install smoke (scripts/check-pack-install.mjs copies it into an empty
// consumer that installed the packed tarball, then runs it there): import the
// package by its published name, never from the source. The v2 root and
// subpath exports work and agree, and the retired v1 root names and subpaths
// are gone. (The installed name/version and the unscoped name are the master
// script's identity checks.)
import * as root from "@scshafe/switchyard";
import { createGraphDefinition } from "@scshafe/switchyard/graph/definition";
import { compileGraph } from "@scshafe/switchyard/graph/compile";
import { projectGraphDisplay } from "@scshafe/switchyard/graph/display";
import { graphDefinitionDiff } from "@scshafe/switchyard/graph/diff";
import { createJoinInputArtifact, validateJoinInputArtifact } from "@scshafe/switchyard/store/join-input";
import { withDeclaredFailureOutcomes } from "@scshafe/switchyard/execute/declared-failures";
import { nodeTurnIdempotencyKey } from "@scshafe/switchyard/execute/turn";
import { runClaimedUnitTurn } from "@scshafe/switchyard/execute/unit-runner";
import { validateModelStageBinding } from "@scshafe/switchyard/model/binding";
import { AGENT_STEP_REQUEST_SCHEMA_VERSION } from "@scshafe/switchyard/agent/step";
import { compileGateFlow } from "@scshafe/switchyard/gate/compiler";
import metadata from "@scshafe/switchyard/package.json" with { type: "json" };

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
  || root.JOIN_INPUT_ARTIFACT_CONTRACT !== "switchyard.join-input.v1"
  || "declaredFailureRecoveryUsage" in root || "isDeclaredFailureUnresolved" in root) {
  throw new Error("P7/P8 public export boundary mismatch");
}
if (AGENT_STEP_REQUEST_SCHEMA_VERSION !== "agent-step-request.v1" || typeof compileGateFlow !== "function") {
  throw new Error("agent/gate helper export missing");
}
if (metadata.name !== "@scshafe/switchyard") {
  throw new Error("package name mismatch");
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
    await import("@scshafe/switchyard/" + subpath);
    throw new Error("retired subpath resolved: " + subpath);
  } catch (error) {
    if (String(error?.message).startsWith("retired subpath resolved:")) throw error;
  }
}
