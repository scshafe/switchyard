// Approval / review fixtures: small graphs, scripted ports, and a memory-store
// harness that drains every worker principal and records human decisions.

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { codeNodePortByNode } from "@scshafe/switchyard/execute/code-port";
import {
  approvalReviewHumanDecision,
  withApprovalReviewPorts
} from "@scshafe/switchyard/execute/approval-review";
import { recordHumanNodeDecision, runNextUnitTurn } from "@scshafe/switchyard/execute/unit-runner";
import { createGraphDefinition, graphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import { MemoryGraphStore } from "@scshafe/switchyard/store/memory-graph-store";
import { MemoryUnitStore } from "@scshafe/switchyard/store/memory-unit-store";

export const TURN = Object.freeze({
  idempotency: "per (unitId, nodeId, attemptNumber)",
  leaseMs: 30_000,
  maxAttempts: 2,
  retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
});

const binding = (bindingId, fill) => Object.freeze({ kind: "model", bindingId, version: 1, bindingDigest: fill.repeat(64) });
export const BINDINGS = Object.freeze({
  cloud: binding("fixture.cloud-model", "c"),
  local: binding("fixture.local-screen", "d"),
  reviewer: binding("fixture.strong-reviewer", "e"),
  small: binding("fixture.small-judge", "f"),
  big: binding("fixture.big-judge", "a")
});

export const PRINCIPALS = Object.freeze({
  worker: "ar_worker",
  cloud: "ar_cloud",
  screen: "ar_screen",
  reviewer: "ar_reviewer",
  small: "ar_small",
  big: "ar_big",
  console: "ar_console",
  admitter: "ar_admitter"
});
const WORKER_PRINCIPALS = [PRINCIPALS.worker, PRINCIPALS.cloud, PRINCIPALS.screen, PRINCIPALS.reviewer, PRINCIPALS.small, PRINCIPALS.big];

export const CONTRACTS = Object.freeze({ question: "fixture.question.v1", answer: "fixture.answer.v1" });

export const ACTORS = Object.freeze({
  human: Object.freeze({ kind: "human", principal: { id: PRINCIPALS.console } }),
  screen: Object.freeze({ kind: "model", binding: BINDINGS.local, principal: { id: PRINCIPALS.screen } }),
  reviewer: Object.freeze({ kind: "model", binding: BINDINGS.reviewer, principal: { id: PRINCIPALS.reviewer } }),
  big: Object.freeze({ kind: "model", binding: BINDINGS.big, principal: { id: PRINCIPALS.big } })
});

export function node(nodeId, outcomes, options = {}) {
  const kind = options.kind ?? "code";
  return {
    nodeId,
    ref: { id: options.refId ?? `fixture.${nodeId}`, version: options.version ?? 1 },
    kind,
    input: options.input ?? CONTRACTS.question,
    outcomes: { version: options.version ?? 1, outcomes },
    ...(options.outputs ? { outputs: options.outputs } : {}),
    principal: { id: options.principal ?? (kind === "human" ? PRINCIPALS.console : kind === "model" ? PRINCIPALS.cloud : PRINCIPALS.worker) },
    ...(kind === "model" ? { binding: options.binding ?? BINDINGS.cloud } : {}),
    turn: { ...TURN, ...(options.turn ?? {}) },
    ...(options.join ? { join: options.join } : {}),
    ...(options.approval ? { approval: options.approval } : {}),
    ...(options.review ? { review: options.review } : {})
  };
}

/**
 * `draft` (a cloud model answering a question) -> `publish`. Optional
 * settings go on `draft`; `escalate` / `refused` exist when a route names them.
 */
export function qaDraft({ approval, review, graphId = "fixture.qa" } = {}) {
  const nodes = [
    node("draft", ["done"], { kind: "model", outputs: { done: CONTRACTS.answer }, approval, review }),
    node("publish", ["published"], { input: CONTRACTS.answer })
  ];
  const targets = [approval?.onDeny?.to, review?.onReject?.to].filter(Boolean);
  if (targets.includes("escalate")) {
    nodes.push(node("escalate", ["handled"], { kind: "human", input: "switchyard.review-rejected.v1" }));
  }
  if (targets.includes("refused")) nodes.push(node("refused", ["noted"]));
  return {
    graphId,
    version: 1,
    description: "A drafted answer, optionally approved before and reviewed after.",
    entry: "draft",
    nodes,
    edges: [{ edgeId: "draft-done", from: "draft", when: { outcome: "done" }, to: ["publish"] }],
    terminals: [
      { nodeId: "publish", outcome: "published" },
      ...(targets.includes("escalate") ? [{ nodeId: "escalate", outcome: "handled" }] : []),
      ...(targets.includes("refused") ? [{ nodeId: "refused", outcome: "noted" }] : [])
    ]
  };
}

/** `split` fans out to a reviewed `left` and a plain `right`, joined by `gather`. */
export function fanoutDraft({ review, require = "all" } = {}) {
  return {
    graphId: "fixture.fanout",
    version: 1,
    description: "A reviewed branch inside a fan-out and envelope join.",
    entry: "split",
    nodes: [
      node("split", ["go"], { outputs: { go: CONTRACTS.question } }),
      node("left", ["done"], { kind: "model", outputs: { done: CONTRACTS.answer }, review }),
      node("right", ["done"], { outputs: { done: CONTRACTS.answer } }),
      node("gather", ["gathered", "join_unsatisfiable"], {
        input: "switchyard.join-input.v1",
        join: { inbound: ["left-done", "right-done"], require, compose: "envelope" }
      })
    ],
    edges: [
      { edgeId: "split-go", from: "split", when: { outcome: "go" }, to: ["left", "right"] },
      { edgeId: "left-done", from: "left", when: { outcome: "done" }, to: ["gather"] },
      { edgeId: "right-done", from: "right", when: { outcome: "done" }, to: ["gather"] }
    ],
    terminals: [
      { nodeId: "gather", outcome: "gathered" },
      { nodeId: "gather", outcome: "join_unsatisfiable" }
    ]
  };
}

export function receipt(tokens = 10) {
  return {
    schemaVersion: "usage-receipt.v1",
    trust: "provider_reported",
    observedInputTokens: tokens,
    observedOutputTokens: 1,
    chargedTokens: tokens + 1,
    observedCostMicroUsd: 0,
    chargedCostMicroUsd: 0,
    durationMs: 5
  };
}

export const answer = (payload) => createArtifactEnvelope(CONTRACTS.answer, payload);

/**
 * A model port answering from per-node scripts. A script entry is an outcome
 * string, a completion object without usage, or a function of
 * (input, context) returning one. Every call is logged.
 */
export function scriptedModelPort(scripts, log) {
  const cursors = new Map();
  return {
    async invoke(input, bindingRef, context) {
      const script = scripts[context.nodeId];
      if (script === undefined) throw new Error(`no model script for ${context.nodeId}`);
      const index = cursors.get(context.nodeId) ?? 0;
      cursors.set(context.nodeId, index + 1);
      let step = Array.isArray(script) ? script[Math.min(index, script.length - 1)] : script;
      if (typeof step === "function") step = step(input, context);
      if (typeof step === "string") step = { outcome: step };
      log.push({ nodeId: context.nodeId, bindingId: bindingRef.bindingId, input, contractId: context.inputArtifact.contractId, outcome: step.outcome });
      return { ...step, usage: step.usage ?? [receipt()] };
    }
  };
}

export function createHarness({ graph, models = {}, code = {}, decorate = true, unitId = "unit-1", initialState, prefix = "ar", startAt = "2026-09-29T10:00:00.000Z" } = {}) {
  let epoch = Date.parse(startAt);
  let sequence = 0;
  const now = () => new Date((epoch += 1_000));
  const graphStore = new MemoryGraphStore();
  const unitStore = new MemoryUnitStore({
    graphStore,
    now,
    idFactory: (kind) => `${prefix}-${kind}-${++sequence}`,
    ...(initialState === undefined ? {} : { initialState })
  });
  const modelLog = [];
  const codeLog = [];
  const bodies = Object.fromEntries(Object.entries(code).map(([nodeId, body]) => [nodeId, async (input, context) => {
    codeLog.push({ nodeId, input, contractId: context.inputArtifact.contractId });
    return body(input, context);
  }]));
  const raw = { code: codeNodePortByNode(bodies), model: scriptedModelPort(models, modelLog) };
  const ports = decorate ? withApprovalReviewPorts(raw, { graphs: [graph] }) : raw;

  async function admit(seed = { question: "What is the capital of France?" }) {
    await graphStore.publishGraph(graph);
    return unitStore.admitUnit({
      unitId,
      graph: graphDefinitionRef(graph),
      seedArtifact: createArtifactEnvelope(CONTRACTS.question, seed),
      admittedAt: now().toISOString(),
      principalId: PRINCIPALS.admitter
    });
  }

  async function drain() {
    const results = [];
    for (let progressed = true; progressed;) {
      progressed = false;
      for (const principalId of WORKER_PRINCIPALS) {
        const result = await runNextUnitTurn({ store: unitStore, principalId, leaseOwner: "ar-worker", ports, now });
        if (result !== undefined) {
          results.push(result);
          progressed = true;
        }
      }
    }
    return results;
  }

  async function decide(nodeId, outcome, { outputArtifact, actorId = "person-1" } = {}) {
    const queued = await unitStore.listQueuedUnits({ principalId: PRINCIPALS.console, nodeId });
    if (queued.length !== 1) throw new Error(`expected one unit queued at ${nodeId}, found ${queued.length}`);
    const decision = approvalReviewHumanDecision(graph, {
      queued: queued[0],
      outcome,
      ...(outputArtifact === undefined ? {} : { outputArtifact }),
      actor: { actorId }
    });
    return recordHumanNodeDecision({ store: unitStore, principalId: PRINCIPALS.console, decision, now });
  }

  async function openQueues() {
    const open = [];
    for (const graphNode of graph.nodes) {
      for (const entry of await unitStore.listQueuedUnits({ principalId: graphNode.principal.id, nodeId: graphNode.nodeId })) {
        open.push(`${graphNode.nodeId}<${entry.inputArtifact.contractId}>`);
      }
    }
    return open;
  }

  const journey = () => unitStore.readJourney({ unitId });
  return {
    graph,
    unitStore,
    admit,
    drain,
    decide,
    openQueues,
    journey,
    path: async () => (await journey())
      .filter((record) => record.kind === "turn_settled" || record.kind === "join_unsatisfiable")
      .map((record) => `${record.nodeId}:${record.outcome}`),
    settled: async (nodeId) => (await journey()).filter((record) => record.kind === "turn_settled" && record.nodeId === nodeId),
    artifact: (ref) => unitStore.getArtifact({ artifact: ref }),
    modelLog,
    codeLog
  };
}

export const seal = (draft) => createGraphDefinition(draft);
