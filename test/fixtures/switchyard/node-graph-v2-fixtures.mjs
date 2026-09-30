// Loadable, data-only graph drafts for the six DESIGN catalog shapes.

const TURN = Object.freeze({
  idempotency: "per (unitId, nodeId, attemptNumber)",
  leaseMs: 30_000,
  maxAttempts: 2,
  retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
});

const MODEL_BINDING = Object.freeze({
  kind: "model",
  bindingId: "fixture.model.binding",
  version: 1,
  bindingDigest: "a".repeat(64)
});

function node(nodeId, outcomes, options = {}) {
  return {
    nodeId,
    ref: { id: options.refId ?? `fixture.${nodeId}`, version: options.version ?? 1 },
    kind: options.kind ?? "code",
    input: options.input ?? "unit-artifact.v1",
    outcomes: { version: options.version ?? 1, outcomes },
    principal: {
      id: options.principal
        ?? (options.kind === "human"
          ? "v2_console"
          : options.kind === "callback"
            ? "v2_callback"
            : options.kind === "agent"
              ? "v2_agent"
              : options.kind === "model"
                ? "v2_model"
            : "v2_worker")
    },
    ...(options.binding ? { binding: options.binding } : {}),
    turn: { ...TURN, ...(options.turn ?? {}) },
    ...(options.join ? { join: options.join } : {})
  };
}

const filterChain = {
  graphId: "fixture.filter-chain",
  version: 1,
  description: "A linear filter chain with an early terminal rejection.",
  entry: "filter",
  nodes: [
    node("filter", ["pass", "drop"]),
    node("normalize", ["ok"]),
    node("sink", ["done"])
  ],
  edges: [
    { edgeId: "filter-pass", from: "filter", when: { outcome: "pass" }, to: ["normalize"] },
    { edgeId: "normalize-ok", from: "normalize", when: { outcome: "ok" }, to: ["sink"] }
  ],
  terminals: [
    { nodeId: "filter", outcome: "drop" },
    { nodeId: "sink", outcome: "done" }
  ]
};

const outcomeRouter = {
  graphId: "fixture.outcome-router",
  version: 1,
  description: "A model outcome router with two branches and one terminal outcome.",
  entry: "classify",
  nodes: [
    node("classify", ["jobs", "receipts", "noise"], {
      kind: "model",
      binding: MODEL_BINDING
    }),
    node("jobs", ["accepted"]),
    node("receipts", ["accepted"])
  ],
  edges: [
    { edgeId: "route-jobs", from: "classify", when: { outcome: "jobs" }, to: ["jobs"] },
    { edgeId: "route-receipts", from: "classify", when: { outcome: "receipts" }, to: ["receipts"] }
  ],
  terminals: [
    { nodeId: "classify", outcome: "noise" },
    { nodeId: "jobs", outcome: "accepted" },
    { nodeId: "receipts", outcome: "accepted" }
  ]
};

const escalationLadder = {
  graphId: "fixture.escalation-ladder",
  version: 1,
  description: "An explicit two-tier human escalation ladder.",
  entry: "triage",
  nodes: [
    node("triage", ["resolved", "escalate"]),
    node("review-tier-1", ["resolved", "escalate"], { kind: "human" }),
    node("tier-1-timer", ["elapsed", "operator-fired"], { kind: "callback" }),
    node("tier-1-race", ["resolved", "escalate", "join_unsatisfiable"], {
      join: {
        inbound: ["tier-1-decision", "tier-1-timeout"],
        require: { nOf: 1 }
      }
    }),
    node("review-tier-2", ["resolved", "rejected"], { kind: "human" })
  ],
  edges: [
    {
      edgeId: "triage-escalate",
      from: "triage",
      when: { outcome: "escalate" },
      to: ["review-tier-1", "tier-1-timer"]
    },
    {
      edgeId: "tier-1-decision",
      from: "review-tier-1",
      when: { anyOf: ["resolved", "escalate"] },
      to: ["tier-1-race"]
    },
    {
      edgeId: "tier-1-timeout",
      from: "tier-1-timer",
      when: { anyOf: ["elapsed", "operator-fired"] },
      to: ["tier-1-race"]
    },
    {
      edgeId: "race-escalates",
      from: "tier-1-race",
      when: { outcome: "escalate" },
      to: ["review-tier-2"]
    }
  ],
  terminals: [
    { nodeId: "triage", outcome: "resolved" },
    { nodeId: "tier-1-race", outcome: "resolved" },
    { nodeId: "tier-1-race", outcome: "join_unsatisfiable" },
    { nodeId: "review-tier-2", outcome: "resolved" },
    { nodeId: "review-tier-2", outcome: "rejected" }
  ]
};

const humanInTheMiddle = {
  graphId: "fixture.human-in-the-middle",
  version: 1,
  description: "A human decision routes an approved unit onward instead of terminating by kind.",
  entry: "draft",
  nodes: [
    node("draft", ["proposed"]),
    node("approve", ["approved", "rejected"], { kind: "human" }),
    node("publish", ["published"])
  ],
  edges: [
    { edgeId: "draft-proposed", from: "draft", when: { outcome: "proposed" }, to: ["approve"] },
    { edgeId: "approval-granted", from: "approve", when: { outcome: "approved" }, to: ["publish"] }
  ],
  terminals: [
    { nodeId: "approve", outcome: "rejected" },
    { nodeId: "publish", outcome: "published" }
  ]
};

const join = {
  graphId: "fixture.join",
  version: 1,
  description: "A fan-out followed by an all-of join over stable inbound edge IDs.",
  entry: "start",
  nodes: [
    node("start", ["ready"]),
    node("branch-a", ["done"]),
    node("branch-b", ["done"]),
    node("join", ["joined", "join_unsatisfiable"], {
      join: { inbound: ["branch-a-to-join", "branch-b-to-join"], require: "all" }
    })
  ],
  edges: [
    { edgeId: "fan-out", from: "start", when: { outcome: "ready" }, to: ["branch-a", "branch-b"] },
    { edgeId: "branch-a-to-join", from: "branch-a", when: { outcome: "done" }, to: ["join"] },
    { edgeId: "branch-b-to-join", from: "branch-b", when: { outcome: "done" }, to: ["join"] }
  ],
  terminals: [
    { nodeId: "join", outcome: "joined" },
    { nodeId: "join", outcome: "join_unsatisfiable" }
  ]
};

const shadowLane = {
  graphId: "fixture.shadow-lane",
  version: 1,
  description: "An unconditional primary route plus an additive conditional shadow lane.",
  entry: "classify",
  nodes: [
    node("classify", ["routed"]),
    node("primary", ["done"]),
    node("shadow", ["observed"], { kind: "agent" })
  ],
  edges: [
    { edgeId: "primary-route", from: "classify", when: { outcome: "routed" }, to: ["primary"] },
    {
      edgeId: "shadow-high-risk",
      from: "classify",
      when: {
        outcome: "routed",
        where: [{ pointer: "/payload/risk", equals: "high" }]
      },
      to: ["shadow"]
    }
  ],
  terminals: [
    { nodeId: "primary", outcome: "done" },
    { nodeId: "shadow", outcome: "observed" }
  ]
};

export const fixtureGraphs = Object.freeze({
  "filter-chain": filterChain,
  "outcome-router": outcomeRouter,
  "escalation-ladder": escalationLadder,
  "human-in-the-middle": humanInTheMiddle,
  join,
  "shadow-lane": shadowLane
});

const unreachableNode = structuredClone(filterChain);
unreachableNode.nodes.push(node("orphan", ["done"]));
unreachableNode.terminals.push({ nodeId: "orphan", outcome: "done" });

const uncoveredOutcome = structuredClone(filterChain);
uncoveredOutcome.terminals = uncoveredOutcome.terminals.filter(
  (terminal) => !(terminal.nodeId === "filter" && terminal.outcome === "drop")
);

const joinOverNonInboundEdge = structuredClone(join);
joinOverNonInboundEdge.nodes.find((candidate) => candidate.nodeId === "join").join.inbound = [
  "fan-out",
  "branch-b-to-join"
];

const undeclaredOutcomeInEdge = structuredClone(filterChain);
undeclaredOutcomeInEdge.edges.find((edge) => edge.edgeId === "filter-pass").when.outcome = "mystery";

export const adversarialGraphs = Object.freeze({
  "unreachable-node": unreachableNode,
  "uncovered-outcome": uncoveredOutcome,
  "join-over-non-inbound-edge": joinOverNonInboundEdge,
  "undeclared-outcome-in-edge": undeclaredOutcomeInEdge
});

export { MODEL_BINDING, TURN, node };
