// execute/approval-review.ts — compose the review and rework records.
//
// The sealed graph already contains the approval / review nodes (see
// graph/approval-review.ts). What it cannot do by itself is put a node's
// input and its output into one record for the reviewer, or turn a reviewer's
// rejection into the next round's input. That composition is the pure
// function `applyApprovalReviewCompletion`, applied host-side by a port
// decorator (`withApprovalReviewPorts`) for worker bodies and by
// `approvalReviewHumanDecision` for people. No runner or store changes: the
// compiled graph declares the composed contracts, so a host that forgets the
// decorator fails closed at the runner's ordinary completion validation.

import {
  createArtifactEnvelope,
  validateArtifactEnvelope,
  type ArtifactEnvelope,
  type ContractId
} from "../contracts/artifact.js";
import { compileGraph } from "../graph/compile.js";
import {
  validateGraphDefinition,
  type GraphDefinition,
  type SwitchyardNode,
  type SwitchyardNodeRef
} from "../graph/definition.js";
import {
  APPROVAL_OUTCOMES,
  REVIEW_REJECTED_OUTCOME,
  REVIEW_REWORK_OUTCOME,
  REVIEWER_OUTCOMES,
  SWITCHYARD_REVIEW_NOTES_CONTRACT,
  SWITCHYARD_REVIEW_REJECTED_CONTRACT,
  SWITCHYARD_REVIEW_REQUEST_CONTRACT,
  SWITCHYARD_REWORK_CONTRACT,
  approvalReviewRole,
  reviewAcceptedOutcome,
  reviewMaxRounds,
  reviewNodeId,
  reviewedOutcomes,
  type ApprovalReviewRole
} from "../graph/approval-review.js";
import {
  captureCapabilityDataProperty,
  captureCapabilityMethod,
  captureCapabilityRecord
} from "../internal/capability.js";
import { isPlainObject, typeName } from "../internal/guards.js";
import type { QueuedUnit } from "../store/unit-store.js";
import { ExecutionFailureError } from "./failure.js";
import {
  validateNodeTurnCompletion,
  type CodeNodePort,
  type HumanNodeDecision,
  type ModelNodePort,
  type NodeTurnActorAttribution,
  type NodeTurnCompletion,
  type WorkerNodeTurnContext
} from "./ports.js";
import type { WorkerNodePorts } from "./turn.js";

export const MAX_REVIEW_NOTES_LENGTH = 16_384;

/** An artifact embedded in a review record: content identity plus payload. */
export interface EmbeddedArtifact {
  readonly contractId: ContractId;
  readonly digest: string;
  readonly payload: unknown;
}

export interface ReviewSubject {
  readonly nodeId: string;
  readonly nodeRef: SwitchyardNodeRef;
}

/** One rejected round, oldest first. `feedback` is the reviewer's artifact. */
export interface ReviewHistoryEntry {
  readonly round: number;
  readonly outcome: string;
  readonly output: EmbeddedArtifact;
  readonly feedback: EmbeddedArtifact | null;
}

/** Input of `<nodeId>::review` (`switchyard.review-request.v1`). */
export interface ReviewRequestPayload {
  readonly schemaVersion: typeof SWITCHYARD_REVIEW_REQUEST_CONTRACT;
  readonly subject: ReviewSubject;
  /** The round under review, 1-based. */
  readonly round: number;
  /** Sealed bound; null under `onReject: { retry: true }`. */
  readonly maxRounds: number | null;
  /** The subject's original input. */
  readonly input: EmbeddedArtifact;
  /** The subject's outcome in this round. */
  readonly outcome: string;
  /** What the subject produced (its input, when it carried the input forward). */
  readonly output: EmbeddedArtifact;
  readonly history: readonly ReviewHistoryEntry[];
}

/** Input of `<nodeId>::rework` (`switchyard.rework.v1`). */
export interface ReworkPayload {
  readonly schemaVersion: typeof SWITCHYARD_REWORK_CONTRACT;
  readonly subject: ReviewSubject;
  /** The round about to run, 2-based. The latest notes are `history.at(-1)`. */
  readonly round: number;
  readonly maxRounds: number | null;
  readonly input: EmbeddedArtifact;
  readonly history: readonly ReviewHistoryEntry[];
}

/** Carried by a final rejection (`switchyard.review-rejected.v1`). */
export interface ReviewRejectedPayload {
  readonly schemaVersion: typeof SWITCHYARD_REVIEW_REJECTED_CONTRACT;
  readonly subject: ReviewSubject;
  readonly maxRounds: number;
  readonly input: EmbeddedArtifact;
  readonly history: readonly ReviewHistoryEntry[];
}

export interface ReviewNotesPayload {
  readonly notes: string;
}

/** Plain-text reviewer feedback for a `rejected` answer. */
export function reviewNotes(notes: string): ArtifactEnvelope {
  if (typeof notes !== "string" || notes.trim().length === 0 || notes.length > MAX_REVIEW_NOTES_LENGTH) {
    throw new Error(`review notes: must be a non-blank string of at most ${MAX_REVIEW_NOTES_LENGTH} characters`);
  }
  return createArtifactEnvelope(SWITCHYARD_REVIEW_NOTES_CONTRACT, { notes });
}

function embed(artifact: ArtifactEnvelope): EmbeddedArtifact {
  return { contractId: artifact.contractId, digest: artifact.digest, payload: artifact.payload };
}

function subjectOf(node: SwitchyardNode): ReviewSubject {
  return { nodeId: node.nodeId, nodeRef: { id: node.ref.id, version: node.ref.version } };
}

function record(label: string, value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label}: must be an object (got ${typeName(value)})`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label}: must have exactly the keys ${keys.join(", ")}`);
  }
  return value;
}

function embedded(label: string, value: unknown): EmbeddedArtifact {
  const raw = record(label, value, ["contractId", "digest", "payload"]);
  return embed(validateArtifactEnvelope(raw));
}

function positiveInt(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label}: must be a positive safe integer`);
  }
  return value;
}

interface ReadRecord {
  readonly round: number;
  readonly input: EmbeddedArtifact;
  readonly history: readonly ReviewHistoryEntry[];
  readonly outcome?: string;
  readonly output?: EmbeddedArtifact;
}

/**
 * Validate an engine-composed review or rework record against the sealed
 * subject: identity, bound, round arithmetic and every embedded digest.
 */
function readRecord(
  subject: SwitchyardNode,
  artifactRaw: ArtifactEnvelope,
  kind: "request" | "rework"
): ReadRecord {
  const contract = kind === "request" ? SWITCHYARD_REVIEW_REQUEST_CONTRACT : SWITCHYARD_REWORK_CONTRACT;
  const label = `${contract} for ${subject.nodeId}`;
  const artifact = validateArtifactEnvelope(artifactRaw);
  if (artifact.contractId !== contract) {
    throw new Error(`${label}: expected contract ${contract} (got ${artifact.contractId})`);
  }
  const keys = kind === "request"
    ? ["schemaVersion", "subject", "round", "maxRounds", "input", "outcome", "output", "history"]
    : ["schemaVersion", "subject", "round", "maxRounds", "input", "history"];
  const raw = record(label, artifact.payload, keys);
  if (raw.schemaVersion !== contract) throw new Error(`${label}: schemaVersion must be ${contract}`);
  const claimed = record(`${label}.subject`, raw.subject, ["nodeId", "nodeRef"]);
  const ref = record(`${label}.subject.nodeRef`, claimed.nodeRef, ["id", "version"]);
  if (claimed.nodeId !== subject.nodeId || ref.id !== subject.ref.id || ref.version !== subject.ref.version) {
    throw new Error(`${label}: subject does not match the sealed node`);
  }
  const bound = reviewMaxRounds(subject.review!);
  if (raw.maxRounds !== bound) {
    throw new Error(`${label}: maxRounds ${String(raw.maxRounds)} does not match the sealed ${String(bound)}`);
  }
  const round = positiveInt(`${label}.round`, raw.round);
  if (kind === "rework" && round < 2) throw new Error(`${label}.round: a rework starts at round 2`);
  if (bound !== null && round > bound) {
    throw new Error(`${label}.round: ${round} exceeds maxRounds ${bound}`);
  }
  const input = embedded(`${label}.input`, raw.input);
  if (input.contractId !== subject.input) {
    throw new Error(`${label}.input: expected the node's input contract ${subject.input} (got ${input.contractId})`);
  }
  const outcomes = reviewedOutcomes(subject);
  if (!Array.isArray(raw.history) || raw.history.length !== round - 1) {
    throw new Error(`${label}.history: round ${round} carries exactly ${round - 1} earlier round(s)`);
  }
  const history = raw.history.map((entryRaw, index): ReviewHistoryEntry => {
    const entryLabel = `${label}.history[${index}]`;
    const entry = record(entryLabel, entryRaw, ["round", "outcome", "output", "feedback"]);
    if (entry.round !== index + 1) throw new Error(`${entryLabel}.round must be ${index + 1}`);
    if (typeof entry.outcome !== "string" || !outcomes.includes(entry.outcome)) {
      throw new Error(`${entryLabel}.outcome is not an outcome of ${subject.nodeId}`);
    }
    return {
      round: index + 1,
      outcome: entry.outcome,
      output: embedded(`${entryLabel}.output`, entry.output),
      feedback: entry.feedback === null ? null : embedded(`${entryLabel}.feedback`, entry.feedback)
    };
  });
  if (kind === "rework") return { round, input, history };
  if (typeof raw.outcome !== "string" || !outcomes.includes(raw.outcome)) {
    throw new Error(`${label}.outcome is not an outcome of ${subject.nodeId}`);
  }
  return { round, input, history, outcome: raw.outcome, output: embedded(`${label}.output`, raw.output) };
}

function withUsage(
  completion: { readonly outcome: string; readonly outputArtifact: ArtifactEnvelope | EmbeddedArtifact },
  source: NodeTurnCompletion
): NodeTurnCompletion {
  return Object.freeze({
    outcome: completion.outcome,
    outputArtifact: completion.outputArtifact as ArtifactEnvelope,
    ...(Object.hasOwn(source, "usage") && source.usage !== undefined ? { usage: source.usage } : {})
  });
}

function requestFor(
  subject: SwitchyardNode,
  round: number,
  input: EmbeddedArtifact,
  history: readonly ReviewHistoryEntry[],
  body: NodeTurnCompletion
): NodeTurnCompletion {
  const output = body.outputArtifact === undefined ? input : embed(body.outputArtifact);
  const payload: ReviewRequestPayload = {
    schemaVersion: SWITCHYARD_REVIEW_REQUEST_CONTRACT,
    subject: subjectOf(subject),
    round,
    maxRounds: reviewMaxRounds(subject.review!),
    input,
    outcome: body.outcome,
    output,
    history
  };
  return withUsage(
    { outcome: body.outcome, outputArtifact: createArtifactEnvelope(SWITCHYARD_REVIEW_REQUEST_CONTRACT, payload) },
    body
  );
}

/** What a reviewer body may return, checked before the answer is mapped. */
function reviewerBodyNode(subject: SwitchyardNode): SwitchyardNode {
  const review = subject.review!;
  return {
    nodeId: reviewNodeId(subject.nodeId),
    ref: subject.ref,
    kind: review.by.kind,
    input: SWITCHYARD_REVIEW_REQUEST_CONTRACT,
    outcomes: { version: subject.ref.version, outcomes: [...REVIEWER_OUTCOMES] },
    principal: review.by.principal,
    ...(review.by.kind === "model" ? { binding: review.by.binding } : {}),
    turn: subject.turn
  } as SwitchyardNode;
}

function shape(
  role: ApprovalReviewRole,
  inputArtifact: ArtifactEnvelope,
  completion: unknown
): NodeTurnCompletion | undefined {
  const subject = role.subject;
  const review = Object.hasOwn(subject, "review") ? subject.review : undefined;
  if (role.role === "approval" || review === undefined) return undefined;
  const label = `node ${role.nodeId} body result`;
  if (role.role === "subject") {
    const input = validateArtifactEnvelope(inputArtifact);
    if (input.contractId !== subject.input) {
      throw new Error(`${label}: input contract ${input.contractId} is not ${subject.input}`);
    }
    const body = validateNodeTurnCompletion(subject, completion, label);
    return requestFor(subject, 1, embed(input), [], body);
  }
  if (role.role === "rework") {
    const rework = readRecord(subject, inputArtifact, "rework");
    const body = validateNodeTurnCompletion(subject, completion, label);
    return requestFor(subject, rework.round, rework.input, rework.history, body);
  }
  const request = readRecord(subject, inputArtifact, "request");
  const verdict = validateNodeTurnCompletion(reviewerBodyNode(subject), completion, label);
  if (verdict.outcome === "accepted") {
    if (verdict.outputArtifact !== undefined) {
      throw new Error(`${label}: "accepted" carries the reviewed output onward and takes no feedback artifact`);
    }
    return withUsage(
      { outcome: reviewAcceptedOutcome(request.outcome!), outputArtifact: request.output! },
      verdict
    );
  }
  const history: readonly ReviewHistoryEntry[] = [
    ...request.history,
    {
      round: request.round,
      outcome: request.outcome!,
      output: request.output!,
      feedback: verdict.outputArtifact === undefined ? null : embed(verdict.outputArtifact)
    }
  ];
  const maxRounds = reviewMaxRounds(review);
  if (maxRounds === null || request.round < maxRounds) {
    const payload: ReworkPayload = {
      schemaVersion: SWITCHYARD_REWORK_CONTRACT,
      subject: subjectOf(subject),
      round: request.round + 1,
      maxRounds,
      input: request.input,
      history
    };
    return withUsage({
      outcome: maxRounds === null ? REVIEW_REJECTED_OUTCOME : REVIEW_REWORK_OUTCOME,
      outputArtifact: createArtifactEnvelope(SWITCHYARD_REWORK_CONTRACT, payload)
    }, verdict);
  }
  const payload: ReviewRejectedPayload = {
    schemaVersion: SWITCHYARD_REVIEW_REJECTED_CONTRACT,
    subject: subjectOf(subject),
    maxRounds,
    input: request.input,
    history
  };
  return withUsage({
    outcome: REVIEW_REJECTED_OUTCOME,
    outputArtifact: createArtifactEnvelope(SWITCHYARD_REVIEW_REJECTED_CONTRACT, payload)
  }, verdict);
}

export interface ApplyApprovalReviewInput {
  readonly nodeId: string;
  /** The queued input of this turn, as a full envelope. */
  readonly inputArtifact: ArtifactEnvelope;
  /** What the node's body (or person) answered. */
  readonly completion: NodeTurnCompletion;
}

/**
 * Turn a body's own answer into what the sealed node settles with:
 * a reviewed node's output becomes a review request; a reviewer's
 * `accepted` / `rejected` becomes `accepted:<outcome>` (carrying the
 * reviewed output unchanged), `rework` (the next round's input) or a final
 * `rejected`. Every other node's answer is returned unchanged.
 */
export function applyApprovalReviewCompletion(
  graphRaw: GraphDefinition,
  input: ApplyApprovalReviewInput
): NodeTurnCompletion {
  const graph = validateGraphDefinition(graphRaw);
  compileGraph(graph);
  const raw = captureCapabilityRecord(input, ["nodeId", "inputArtifact", "completion"], ["nodeId", "inputArtifact", "completion"], "approval/review input");
  const role = approvalReviewRole(graph, raw.nodeId as string);
  const shaped = role === undefined
    ? undefined
    : shape(role, raw.inputArtifact as ArtifactEnvelope, raw.completion);
  return shaped ?? (raw.completion as NodeTurnCompletion);
}

export interface ApprovalReviewHumanDecisionInput {
  readonly queued: Pick<QueuedUnit, "queueId" | "unitId" | "nodeId" | "inputArtifact">;
  readonly outcome: string;
  readonly outputArtifact?: ArtifactEnvelope;
  readonly actor: NodeTurnActorAttribution;
}

/**
 * A person's answer at an approval, review, reviewed or rework node, shaped
 * for `recordHumanNodeDecision`. Approvers answer `approved` / `denied`;
 * reviewers `accepted` / `rejected` (optionally with `reviewNotes(...)`).
 */
export function approvalReviewHumanDecision(
  graph: GraphDefinition,
  input: ApprovalReviewHumanDecisionInput
): HumanNodeDecision {
  const raw = captureCapabilityRecord(input, ["queued", "outcome", "outputArtifact", "actor"], ["queued", "outcome", "actor"], "human decision input");
  // A full QueuedUnit is accepted; only these four fields are read.
  const queued = Object.fromEntries(
    (["queueId", "unitId", "nodeId", "inputArtifact"] as const).map((key) => [
      key,
      captureCapabilityDataProperty(raw.queued, key, "human decision input.queued")
    ])
  );
  const completion = applyApprovalReviewCompletion(graph, {
    nodeId: queued.nodeId as string,
    inputArtifact: queued.inputArtifact as ArtifactEnvelope,
    completion: {
      outcome: raw.outcome as string,
      ...(raw.outputArtifact === undefined ? {} : { outputArtifact: raw.outputArtifact as ArtifactEnvelope })
    }
  });
  return Object.freeze({
    queueId: queued.queueId as string,
    unitId: queued.unitId as string,
    nodeId: queued.nodeId as string,
    outcome: completion.outcome,
    ...(completion.outputArtifact === undefined ? {} : { outputArtifact: completion.outputArtifact }),
    actor: raw.actor as NodeTurnActorAttribution
  });
}

/**
 * The answers a person (or a model body) gives at a node, which are not
 * always the node's sealed outcomes: an approval node is answered
 * `approved | denied`, a review node `accepted | rejected` (stored as
 * `accepted:<outcome>`, `rework` or `rejected`), and a reviewed node or its
 * rework twin with the subject's own outcomes. Any other node is answered
 * with its outcomes. Pass the answer to `approvalReviewHumanDecision`.
 */
export function humanNodeAnswers(graphRaw: GraphDefinition, nodeId: string): readonly string[] {
  const graph = validateGraphDefinition(graphRaw);
  const role = approvalReviewRole(graph, nodeId);
  if (role?.role === "approval") return APPROVAL_OUTCOMES;
  if (role?.role === "review") return REVIEWER_OUTCOMES;
  if (role !== undefined) return Object.freeze(reviewedOutcomes(role.subject).slice());
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) throw new Error(`graph ${graph.graphId} has no node ${JSON.stringify(nodeId)}`);
  return Object.freeze(reviewedOutcomes(node).slice());
}

export interface ApprovalReviewPortOptions {
  /** Every sealed graph whose units these ports run. Others pass through. */
  readonly graphs: readonly GraphDefinition[];
}

class ApprovalReviewResultError extends ExecutionFailureError {
  constructor(message: string, cause: unknown) {
    super("immutable_stage_contract_rejected", false, cause);
    this.name = "ApprovalReviewResultError";
    this.message = message;
  }
}

function usageOf(result: unknown): unknown {
  if (result === null || typeof result !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(result, "usage");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Decorate worker ports so reviewed nodes, rework twins and model reviewers
 * settle with the composed records. Approval nodes and ordinary nodes pass
 * through untouched. An invalid body result fails the turn terminally; a
 * metered (model) one is handed to the runner as the undeclared outcome
 * `invalid.<role>-result` so the runner keeps its usage receipt.
 */
export function withApprovalReviewPorts(
  portsRaw: WorkerNodePorts,
  options: ApprovalReviewPortOptions
): WorkerNodePorts {
  const ports = captureCapabilityRecord(portsRaw, ["code", "model", "agent"], [], "approval/review ports");
  const opts = captureCapabilityRecord(options, ["graphs"], ["graphs"], "approval/review port options");
  if (!Array.isArray(opts.graphs)) throw new Error("approval/review port options.graphs must be an array");
  const graphs = new Map<string, GraphDefinition>();
  for (const graphRaw of opts.graphs as unknown[]) {
    const graph = validateGraphDefinition(graphRaw);
    compileGraph(graph);
    graphs.set(graph.graphDigest, graph);
  }

  const roleFor = (context: WorkerNodeTurnContext): ApprovalReviewRole | undefined => {
    const graph = graphs.get(context.graph.digest);
    if (graph === undefined) return undefined;
    const role = approvalReviewRole(graph, context.nodeId);
    if (role === undefined || role.role === "approval") return undefined;
    return Object.hasOwn(role.subject, "review") ? role : undefined;
  };

  const settle = (
    role: ApprovalReviewRole,
    input: unknown,
    context: WorkerNodeTurnContext,
    result: unknown
  ): NodeTurnCompletion => {
    try {
      const inputArtifact = createArtifactEnvelope(context.inputArtifact.contractId, input);
      if (inputArtifact.digest !== context.inputArtifact.digest) {
        throw new Error(`node ${context.nodeId}: the body input does not match the turn's input artifact`);
      }
      return shape(role, inputArtifact, result)!;
    } catch (error) {
      const usage = usageOf(result);
      if (usage !== undefined) {
        return { outcome: `invalid.${role.role}-result`, usage } as unknown as NodeTurnCompletion;
      }
      throw new ApprovalReviewResultError(
        error instanceof Error ? error.message : `node ${context.nodeId}: invalid approval/review result`,
        error
      );
    }
  };

  const decorated: { code?: CodeNodePort; model?: ModelNodePort; agent?: unknown } = {};
  if (ports.code !== undefined) {
    const run = captureCapabilityMethod(ports.code, "run", "code node port");
    decorated.code = Object.freeze({
      async run(input: unknown, context: WorkerNodeTurnContext) {
        const role = roleFor(context);
        const result = await run(input, context);
        return role === undefined ? result : settle(role, input, context, result);
      }
    }) as CodeNodePort;
  }
  if (ports.model !== undefined) {
    const invoke = captureCapabilityMethod(ports.model, "invoke", "model node port");
    decorated.model = Object.freeze({
      async invoke(input: unknown, binding: Parameters<ModelNodePort["invoke"]>[1], context: WorkerNodeTurnContext) {
        const role = roleFor(context);
        const result = await invoke(input, binding, context);
        return role === undefined ? result : settle(role, input, context, result);
      }
    }) as ModelNodePort;
  }
  if (ports.agent !== undefined) decorated.agent = ports.agent;
  return Object.freeze(decorated) as WorkerNodePorts;
}
