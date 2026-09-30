// graph.mjs: the graph. Three authored nodes, sealed into one definition.
//
//   is-question    a small local model answers yes / no / unsure;
//                  unsure goes to a person
//   draft-answer   a "cloud" model drafts an answer, but only after a
//                  local model has approved the text (a PII screen)
//   compose-reply  code turns the draft into a reply, and a person
//                  reviews it after it runs
import {
  NODE_TURN_IDEMPOTENCY,
  NODE_TURN_RETRY_TAXONOMY,
  binaryQuestion,
  createGraphDefinition,
  digest
} from "@scshafe/switchyard";

// Contracts name the shape of the data travelling along an edge.
export const TICKET = "ticket.v1"; // { text }
export const DRAFT = "draft.v1"; // { question, answer }
export const REPLY = "reply.v1"; // { body }

// A principal is "who may run this node". Workers claim turns per principal.
export const PRINCIPALS = {
  local: "local-model",
  cloud: "cloud-model",
  worker: "worker",
  person: "console"
};

// How one turn of a node is run: lease length and retry budget.
const turn = {
  idempotency: NODE_TURN_IDEMPOTENCY,
  retryTaxonomy: NODE_TURN_RETRY_TAXONOMY,
  leaseMs: 30_000,
  maxAttempts: 3
};

// A binding names exactly which model a node runs on. Its digest is part of
// the graph's digest: point a node at another model and it is a new graph.
const binding = (bindingId, model) => ({
  kind: "model",
  bindingId,
  version: 1,
  bindingDigest: digest(model)
});
export const BINDINGS = {
  small: binding("small-local", { model: "qwen2.5-7b", where: "local" }),
  cloud: binding("big-cloud", { model: "big-cloud-model", where: "cloud" })
};

// Actors approve or review. Either a person or a model.
const person = { kind: "human", principal: { id: PRINCIPALS.person } };
const piiScreen = {
  kind: "model",
  binding: BINDINGS.small,
  principal: { id: PRINCIPALS.local }
};

// Node 1: one yes/no question for a small model. "unsure" goes to a person.
const isQuestion = binaryQuestion({
  nodeId: "is-question",
  ref: { id: "first.is-question", version: 1 },
  input: TICKET,
  principal: { id: PRINCIPALS.local },
  binding: BINDINGS.small,
  turn,
  escalate: person,
  yes: { to: "draft-answer" },
  no: "terminal"
});

export const graph = createGraphDefinition({
  graphId: "first-switchyard",
  version: 1,
  description: "Triage a message, draft an answer behind a PII screen, have a person review the reply.",
  entry: "is-question",
  nodes: [
    ...isQuestion.nodes,
    // Node 2: a model node with a model approval before it runs.
    {
      nodeId: "draft-answer",
      ref: { id: "first.draft-answer", version: 1 },
      kind: "model",
      input: TICKET,
      outcomes: { version: 1, outcomes: ["drafted"] },
      outputs: { drafted: DRAFT },
      principal: { id: PRINCIPALS.cloud },
      binding: BINDINGS.cloud,
      turn,
      approval: { by: piiScreen, onDeny: "terminal" }
    },
    // Node 3: a code node with a human review after it runs.
    {
      nodeId: "compose-reply",
      ref: { id: "first.compose-reply", version: 1 },
      kind: "code",
      input: DRAFT,
      outcomes: { version: 1, outcomes: ["composed"] },
      outputs: { composed: REPLY },
      principal: { id: PRINCIPALS.worker },
      turn,
      review: { by: person, onReject: "terminal", maxRounds: 2 }
    }
  ],
  edges: [
    ...isQuestion.edges,
    {
      edgeId: "draft-answer.drafted",
      from: "draft-answer",
      when: { outcome: "drafted" },
      to: ["compose-reply"]
    }
  ],
  terminals: [
    ...isQuestion.terminals,
    { nodeId: "compose-reply", outcome: "composed" }
  ]
});
