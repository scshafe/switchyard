// Switchyard — the dependency-free, digest-sealed node-graph engine.
// Every durable unit position is a per-node queue occurrence. One turn settles
// atomically with its journey evidence, routing, successor queues, and outbox.
//
// STANDALONE RULE: this package imports node: builtins + its own relative files
// ONLY — never mc-* packages, never zod, never any production npm dependency.
// Other codebases consume an independently versioned release.

export * from "./contracts/digest.js";
export * from "./contracts/artifact.js";
export * from "./contracts/usage-receipt.js";
export * from "./graph/limits.js";
export * from "./graph/outcome.js";
export * from "./graph/edge.js";
export * from "./graph/definition.js";
export { compileGraph, sameDeclaredOutputs, type CompiledGraph } from "./graph/compile.js";
export {
  SWITCHYARD_REVIEW_REQUEST_CONTRACT,
  SWITCHYARD_REWORK_CONTRACT,
  SWITCHYARD_REVIEW_REJECTED_CONTRACT,
  SWITCHYARD_REVIEW_NOTES_CONTRACT,
  APPROVAL_OUTCOMES,
  REVIEWER_OUTCOMES,
  REVIEW_ACCEPTED_OUTCOME_PREFIX,
  REVIEW_REWORK_OUTCOME,
  REVIEW_REJECTED_OUTCOME,
  approvalNodeId,
  reviewNodeId,
  reworkNodeId,
  reviewAcceptedOutcome,
  approvalReviewEdgeIds,
  approvalReviewRole,
  type ApprovalReviewRole,
  type ApprovalReviewRoleKind
} from "./graph/approval-review.js";
export * from "./graph/binary.js";
export * from "./graph/display.js";
export * from "./graph/diff.js";
export * from "./graph/budget.js";
export * from "./graph/goals.js";
export * from "./store/graph-store.js";
export * from "./store/memory-graph-store.js";
export * from "./store/unit-store.js";
export * from "./store/routing.js";
export * from "./store/join-input.js";
export * from "./store/memory-unit-store.js";
export * from "./store/unit-path.js";
export * from "./store/goal-closures.js";
export * from "./execute/failure.js";
export * from "./execute/ports.js";
export * from "./execute/turn.js";
export * from "./execute/turn-evidence.js";
export * from "./execute/unit-runner.js";
export * from "./execute/code-port.js";
export * from "./execute/worker.js";
export * from "./execute/fake-model.js";
export * from "./execute/approval-review.js";
export {
  withDeclaredFailureOutcomes,
  type DeclaredFailurePortKind,
  type DeclaredFailureOperation,
  type DeclaredFailureAdmission,
  type DeclaredFailureEvidenceCapture,
  type DeclaredFailureEvidence,
  type DeclaredFailureInvocation,
  type DeclaredFailureCodePort,
  type DeclaredFailureModelPort,
  type DeclaredFailureAgentPort,
  type DeclaredFailureOptions,
  type DeclaredFailureCodeOptions,
  type DeclaredFailureModelOptions,
  type DeclaredFailureAgentOptions
} from "./execute/declared-failures.js";
export * from "./prompt/contracts.js";
export * from "./prompt/compiler.js";
export * from "./model/binding.js";
export * from "./model/invoker.js";
export * from "./gate/contracts.js";
export * from "./gate/certificate.js";
export * from "./gate/compiler.js";
export * from "./agent/step.js";
export * from "./agent/executor-port.js";
export * from "./agent/fake-executor.js";
