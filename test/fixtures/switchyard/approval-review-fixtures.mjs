// Approval / review fixtures: small graphs with approval and review settings.

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { createGraphDefinition } from "@scshafe/switchyard/graph/definition";

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

export const answer = (payload) => createArtifactEnvelope(CONTRACTS.answer, payload);

export const seal = (draft) => createGraphDefinition(draft);
