// graph/approval-review.ts — the sealed expansion of approval / review settings.
//
// A node's `approval` and `review` settings are expanded into ordinary nodes
// and edges before sealing (docs/DESIGN-APPROVAL-REVIEW.md). The expansion is
// a pure function of the draft; `compileGraph` re-derives it and requires the
// sealed graph to be exactly that expansion. Nothing here touches stores,
// runners or artifacts.
//
// This module is imported by definition.ts, so it takes only types from it and
// reads nothing from it at module evaluation.

import type {
  GraphDefinition,
  SwitchyardApproval,
  SwitchyardNode,
  SwitchyardReview,
  SwitchyardRoute,
  TerminalOutcome
} from "./definition.js";
import { canonicalJson } from "../contracts/digest.js";
import { predicateOutcomes, type Edge, type FieldMatch, type OutcomePredicate } from "./edge.js";

/** Reviewer input: the subject's input, the output under review, and history. */
export const SWITCHYARD_REVIEW_REQUEST_CONTRACT = "switchyard.review-request.v1" as const;
/** Rework-twin input: the subject's input and every rejected round so far. */
export const SWITCHYARD_REWORK_CONTRACT = "switchyard.rework.v1" as const;
/** Carried by a final rejection to its `onReject` route. */
export const SWITCHYARD_REVIEW_REJECTED_CONTRACT = "switchyard.review-rejected.v1" as const;
/** Plain-text reviewer feedback built by `reviewNotes`. */
export const SWITCHYARD_REVIEW_NOTES_CONTRACT = "switchyard.review-notes.v1" as const;

/** Outcomes an approver body returns and the approval node declares. */
export const APPROVAL_OUTCOMES = Object.freeze(["approved", "denied"] as const);
/** Outcomes a reviewer body returns; the review node records them mapped. */
export const REVIEWER_OUTCOMES = Object.freeze(["accepted", "rejected"] as const);
/** `accepted:<outcome>` routes the subject's outcome onward unchanged. */
export const REVIEW_ACCEPTED_OUTCOME_PREFIX = "accepted:" as const;
/** A rejection before the last round: back to the node with the notes. */
export const REVIEW_REWORK_OUTCOME = "rework" as const;
/** A final rejection, routed per `onReject`. */
export const REVIEW_REJECTED_OUTCOME = "rejected" as const;

const JOIN_UNSATISFIABLE = "join_unsatisfiable";
const APPROVAL_SUFFIX = "::approval";
const REVIEW_SUFFIX = "::review";
const REWORK_SUFFIX = "::rework";

export function approvalNodeId(nodeId: string): string {
  return `${nodeId}${APPROVAL_SUFFIX}`;
}
export function reviewNodeId(nodeId: string): string {
  return `${nodeId}${REVIEW_SUFFIX}`;
}
export function reworkNodeId(nodeId: string): string {
  return `${nodeId}${REWORK_SUFFIX}`;
}
export function reviewAcceptedOutcome(outcome: string): string {
  return `${REVIEW_ACCEPTED_OUTCOME_PREFIX}${outcome}`;
}

/** Synthesized edge ids, deterministic so a join's `inbound` can name them. */
export function approvalReviewEdgeIds(nodeId: string) {
  return Object.freeze({
    approved: `${approvalNodeId(nodeId)}.approved`,
    denied: `${approvalNodeId(nodeId)}.denied`,
    reviewIn: `${reviewNodeId(nodeId)}.in`,
    rework: `${reviewNodeId(nodeId)}.rework`,
    rejected: `${reviewNodeId(nodeId)}.rejected`,
    reworkOut: `${reworkNodeId(nodeId)}.out`
  });
}

interface GraphBase {
  readonly graphId: string;
  readonly version: number;
  readonly description: string;
  readonly entry: string;
  readonly nodes: readonly SwitchyardNode[];
  readonly edges: readonly Edge[];
  readonly terminals: readonly TerminalOutcome[];
}

function approvalOf(node: SwitchyardNode): SwitchyardApproval | undefined {
  return Object.hasOwn(node, "approval") ? node.approval : undefined;
}
function reviewOf(node: SwitchyardNode): SwitchyardReview | undefined {
  return Object.hasOwn(node, "review") ? node.review : undefined;
}
function isRetry(route: SwitchyardRoute): boolean {
  return typeof route === "object" && Object.hasOwn(route, "retry");
}
function routeTarget(route: SwitchyardRoute): string | undefined {
  return typeof route === "object" && Object.hasOwn(route, "to")
    ? (route as { readonly to: string }).to
    : undefined;
}

/** True when any node carries an approval or review setting. */
export function hasApprovalReviewSettings(graph: { readonly nodes: readonly SwitchyardNode[] }): boolean {
  return graph.nodes.some((node) => approvalOf(node) !== undefined || reviewOf(node) !== undefined);
}

/** Outcomes of a reviewed node that its reviewer sees (all but join_unsatisfiable). */
export function reviewedOutcomes(node: SwitchyardNode): readonly string[] {
  return node.outcomes.outcomes.filter((outcome) => outcome !== JOIN_UNSATISFIABLE);
}

/** Whether a review can send the node back (so the rework twin exists). */
export function reviewHasRework(review: SwitchyardReview): boolean {
  return isRetry(review.onReject) || (review.maxRounds ?? 0) >= 2;
}

/** `null` means unbounded (onReject retry). */
export function reviewMaxRounds(review: SwitchyardReview): number | null {
  return isRetry(review.onReject) ? null : review.maxRounds!;
}

interface SubjectIds {
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
}

function reservedIds(node: SwitchyardNode): SubjectIds {
  const approval = approvalOf(node) !== undefined;
  const review = reviewOf(node) !== undefined;
  const edges = approvalReviewEdgeIds(node.nodeId);
  return {
    nodes: [
      ...(approval ? [approvalNodeId(node.nodeId)] : []),
      ...(review ? [reviewNodeId(node.nodeId), reworkNodeId(node.nodeId)] : [])
    ],
    edges: [
      ...(approval ? [edges.approved, edges.denied] : []),
      ...(review ? [edges.reviewIn, edges.rework, edges.rejected, edges.reworkOut] : [])
    ]
  };
}

function mapPredicate(
  predicate: OutcomePredicate,
  map: (outcome: string) => string
): OutcomePredicate {
  if (Object.hasOwn(predicate, "anyOf")) {
    return { anyOf: (predicate as { readonly anyOf: readonly string[] }).anyOf.map(map) };
  }
  const single = predicate as { readonly outcome: string; readonly where?: readonly FieldMatch[] };
  return Object.hasOwn(predicate, "where")
    ? { outcome: map(single.outcome), where: single.where! }
    : { outcome: map(single.outcome) };
}

/**
 * Remove every synthesized node, edge and terminal and undo the rewrites, so
 * the result is the authored draft. Idempotent on an unexpanded draft, except
 * that an authored reference to a synthesized id (an edge into
 * `X::approval`, an edge out of `X::review` on `accepted:<o>`) is read as the
 * reference it stands for.
 */
function unexpand(graph: GraphBase): GraphBase {
  const subjects = graph.nodes.filter(
    (node) => approvalOf(node) !== undefined || reviewOf(node) !== undefined
  );
  const reservedNodes = new Set<string>();
  const reservedEdges = new Set<string>();
  const approvalTargets = new Map<string, string>();
  const reviewSources = new Map<string, string>();
  const synthesizedTargets = new Map<string, string>();
  for (const subject of subjects) {
    const ids = reservedIds(subject);
    ids.nodes.forEach((id) => reservedNodes.add(id));
    ids.edges.forEach((id) => reservedEdges.add(id));
    if (approvalOf(subject) !== undefined) {
      approvalTargets.set(approvalNodeId(subject.nodeId), subject.nodeId);
    }
    if (reviewOf(subject) !== undefined) {
      reviewSources.set(reviewNodeId(subject.nodeId), subject.nodeId);
      synthesizedTargets.set(reviewNodeId(subject.nodeId), subject.nodeId);
      synthesizedTargets.set(reworkNodeId(subject.nodeId), subject.nodeId);
    }
  }
  const unmapAccepted = (edgeId: string, source: string) => (outcome: string): string => {
    if (!outcome.startsWith(REVIEW_ACCEPTED_OUTCOME_PREFIX)) {
      throw new Error(
        `Graph edge ${edgeId} routes outcome ${JSON.stringify(outcome)} of synthesized node ${source}; a rejection is routed by the review setting's onReject`
      );
    }
    return outcome.slice(REVIEW_ACCEPTED_OUTCOME_PREFIX.length);
  };
  const edges = graph.edges
    .filter((edge) => !reservedEdges.has(edge.edgeId))
    .map((edge): Edge => {
      let from = edge.from;
      let when = edge.when;
      const reviewed = reviewSources.get(edge.from);
      if (reviewed !== undefined) {
        from = reviewed;
        when = mapPredicate(edge.when, unmapAccepted(edge.edgeId, edge.from));
      } else if (reservedNodes.has(edge.from)) {
        throw new Error(
          `Graph edge ${edge.edgeId} leaves synthesized node ${edge.from}; its routes come from the approval/review setting`
        );
      }
      const to = edge.to.map((target) => {
        const approved = approvalTargets.get(target);
        if (approved !== undefined) return approved;
        if (synthesizedTargets.has(target)) {
          throw new Error(
            `Graph edge ${edge.edgeId} targets synthesized node ${target}; route to ${synthesizedTargets.get(target)} instead`
          );
        }
        return target;
      });
      if (new Set(to).size !== to.length) {
        throw new Error(
          `Graph edge ${edge.edgeId} targets both a node and its approval; name the node once`
        );
      }
      return { edgeId: edge.edgeId, from, when, to };
    });
  const terminals: TerminalOutcome[] = [];
  for (const terminal of graph.terminals) {
    if (approvalTargets.has(terminal.nodeId)) continue;
    const reviewed = reviewSources.get(terminal.nodeId);
    if (reviewed !== undefined) {
      if (!terminal.outcome.startsWith(REVIEW_ACCEPTED_OUTCOME_PREFIX)) continue;
      terminals.push({
        nodeId: reviewed,
        outcome: terminal.outcome.slice(REVIEW_ACCEPTED_OUTCOME_PREFIX.length)
      });
      continue;
    }
    if (reservedNodes.has(terminal.nodeId)) continue;
    terminals.push(terminal);
  }
  let entry = graph.entry;
  if (approvalTargets.has(entry)) entry = approvalTargets.get(entry)!;
  else if (reservedNodes.has(entry)) {
    throw new Error(`Graph entry ${entry} is a synthesized node; name the node it belongs to`);
  }
  return {
    graphId: graph.graphId,
    version: graph.version,
    description: graph.description,
    entry,
    nodes: graph.nodes.filter((node) => !reservedNodes.has(node.nodeId)),
    edges,
    terminals
  };
}

function actorFields(actor: SwitchyardApproval["by"]): Record<string, unknown> {
  return {
    kind: actor.kind,
    principal: actor.principal,
    ...(actor.kind === "model" ? { binding: actor.binding } : {})
  };
}

function reviewRefSuffix(review: SwitchyardReview): string {
  const mode = isRetry(review.onReject)
    ? "retry"
    : reviewHasRework(review)
      ? "rounds"
      : "single";
  return `${review.by.kind}.${mode}`;
}

/** Declared-output view of a reviewed node as it runs (compiled graph only). */
export function reviewedSubjectView(node: SwitchyardNode): SwitchyardNode {
  const outputs: Record<string, string> = {};
  for (const outcome of reviewedOutcomes(node)) {
    outputs[outcome] = SWITCHYARD_REVIEW_REQUEST_CONTRACT;
  }
  return { ...node, outputs } as SwitchyardNode;
}

/** Expand an unexpanded draft. Settings are already node-validated. */
function expand(graph: GraphBase): GraphBase {
  const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
  const edgeIds = new Set(graph.edges.map((edge) => edge.edgeId));
  const subjects = graph.nodes.filter(
    (node) => approvalOf(node) !== undefined || reviewOf(node) !== undefined
  );
  const approved = new Map<string, string>();
  const reviewed = new Set<string>();
  for (const subject of subjects) {
    const ids = reservedIds(subject);
    for (const id of ids.nodes) {
      if (nodeIds.has(id)) {
        throw new Error(
          `Graph node id ${id} is reserved for the ${id.endsWith(APPROVAL_SUFFIX) ? "approval" : "review"} of node ${subject.nodeId}; rename it`
        );
      }
    }
    for (const id of ids.edges) {
      if (edgeIds.has(id)) {
        throw new Error(`Graph edge id ${id} is reserved for the settings of node ${subject.nodeId}; rename it`);
      }
    }
    if (approvalOf(subject) !== undefined) approved.set(subject.nodeId, approvalNodeId(subject.nodeId));
    if (reviewOf(subject) !== undefined) reviewed.add(subject.nodeId);
  }
  const allReserved = new Set(subjects.flatMap((subject) => reservedIds(subject).nodes));

  const checkRoute = (subject: SwitchyardNode, route: SwitchyardRoute, label: string): string | undefined => {
    const target = routeTarget(route);
    if (target === undefined) return undefined;
    if (allReserved.has(target)) {
      throw new Error(`Node ${subject.nodeId} ${label} { to: ${target} } names a synthesized node; name the node it belongs to`);
    }
    if (!nodeIds.has(target)) {
      throw new Error(`Node ${subject.nodeId} ${label} { to: ${target} } references unknown node ${target}`);
    }
    if (target === subject.nodeId) {
      throw new Error(`Node ${subject.nodeId} ${label} cannot route back to the node itself; use { retry: true }`);
    }
    return approved.get(target) ?? target;
  };

  // Rewrite authored edges: into an approved node -> its approval; out of a
  // reviewed node on a reviewed outcome -> out of its review, accepted:<o>.
  const edges: Edge[] = graph.edges.map((edge) => {
    let from = edge.from;
    let when = edge.when;
    if (reviewed.has(edge.from)) {
      const outcomes = predicateOutcomes(edge.when);
      const engineOnly = outcomes.every((outcome) => outcome === JOIN_UNSATISFIABLE);
      if (!engineOnly) {
        if (outcomes.includes(JOIN_UNSATISFIABLE)) {
          throw new Error(
            `Graph edge ${edge.edgeId} routes join_unsatisfiable together with reviewed outcomes of ${edge.from}; split it into two edges`
          );
        }
        from = reviewNodeId(edge.from);
        when = mapPredicate(edge.when, reviewAcceptedOutcome);
      }
    }
    return {
      edgeId: edge.edgeId,
      from,
      when,
      to: edge.to.map((target) => approved.get(target) ?? target)
    };
  });
  const terminals: TerminalOutcome[] = graph.terminals.map((terminal) =>
    reviewed.has(terminal.nodeId) && terminal.outcome !== JOIN_UNSATISFIABLE
      ? { nodeId: reviewNodeId(terminal.nodeId), outcome: reviewAcceptedOutcome(terminal.outcome) }
      : terminal
  );

  const nodes: SwitchyardNode[] = [];
  for (const node of graph.nodes) {
    const approval = approvalOf(node);
    const review = reviewOf(node);
    const version = node.ref.version;
    const ids = approvalReviewEdgeIds(node.nodeId);
    if (approval !== undefined) {
      const approvalId = approvalNodeId(node.nodeId);
      nodes.push({
        nodeId: approvalId,
        ref: { id: `${node.ref.id}${APPROVAL_SUFFIX}.${approval.by.kind}`, version },
        ...actorFields(approval.by),
        input: node.input,
        outcomes: { version, outcomes: [...APPROVAL_OUTCOMES] },
        outputs: { approved: node.input, denied: node.input },
        turn: node.turn
      } as unknown as SwitchyardNode);
      edges.push({ edgeId: ids.approved, from: approvalId, when: { outcome: "approved" }, to: [node.nodeId] });
      if (isRetry(approval.onDeny)) {
        edges.push({ edgeId: ids.denied, from: approvalId, when: { outcome: "denied" }, to: [approvalId] });
      } else {
        const target = checkRoute(node, approval.onDeny, "approval.onDeny");
        if (target === undefined) terminals.push({ nodeId: approvalId, outcome: "denied" });
        else edges.push({ edgeId: ids.denied, from: approvalId, when: { outcome: "denied" }, to: [target] });
      }
    }
    nodes.push(node);
    if (review !== undefined) {
      const outcomes = reviewedOutcomes(node);
      if (outcomes.length === 0) {
        throw new Error(`Node ${node.nodeId} has a review but no outcome its body can return`);
      }
      const reviewId = reviewNodeId(node.nodeId);
      const reworkId = reworkNodeId(node.nodeId);
      const retry = isRetry(review.onReject);
      const rework = reviewHasRework(review);
      const declared = Object.hasOwn(node, "outputs") ? node.outputs : undefined;
      const outputs: Record<string, string> = {};
      for (const outcome of outcomes) {
        if (declared !== undefined && Object.hasOwn(declared, outcome)) {
          outputs[reviewAcceptedOutcome(outcome)] = declared[outcome]!;
        }
      }
      if (rework && !retry) outputs[REVIEW_REWORK_OUTCOME] = SWITCHYARD_REWORK_CONTRACT;
      outputs[REVIEW_REJECTED_OUTCOME] = retry
        ? SWITCHYARD_REWORK_CONTRACT
        : SWITCHYARD_REVIEW_REJECTED_CONTRACT;
      nodes.push({
        nodeId: reviewId,
        ref: { id: `${node.ref.id}${REVIEW_SUFFIX}.${reviewRefSuffix(review)}`, version },
        ...actorFields(review.by),
        input: SWITCHYARD_REVIEW_REQUEST_CONTRACT,
        outcomes: {
          version,
          outcomes: [
            ...outcomes.map(reviewAcceptedOutcome),
            ...(rework && !retry ? [REVIEW_REWORK_OUTCOME] : []),
            REVIEW_REJECTED_OUTCOME
          ]
        },
        outputs,
        turn: node.turn
      } as unknown as SwitchyardNode);
      if (rework) {
        const twinOutputs: Record<string, string> = {};
        for (const outcome of outcomes) twinOutputs[outcome] = SWITCHYARD_REVIEW_REQUEST_CONTRACT;
        nodes.push({
          nodeId: reworkId,
          ref: { id: `${node.ref.id}${REWORK_SUFFIX}`, version },
          kind: node.kind,
          input: SWITCHYARD_REWORK_CONTRACT,
          outcomes: { version, outcomes: [...outcomes] },
          outputs: twinOutputs,
          principal: node.principal,
          ...(Object.hasOwn(node, "binding") ? { binding: node.binding } : {}),
          ...(Object.hasOwn(node, "configuration") ? { configuration: node.configuration } : {}),
          turn: node.turn
        } as unknown as SwitchyardNode);
      }
      edges.push({ edgeId: ids.reviewIn, from: node.nodeId, when: { anyOf: [...outcomes] }, to: [reviewId] });
      if (rework && !retry) {
        edges.push({ edgeId: ids.rework, from: reviewId, when: { outcome: REVIEW_REWORK_OUTCOME }, to: [reworkId] });
      }
      if (retry) {
        edges.push({ edgeId: ids.rejected, from: reviewId, when: { outcome: REVIEW_REJECTED_OUTCOME }, to: [reworkId] });
      } else {
        const target = checkRoute(node, review.onReject, "review.onReject");
        if (target === undefined) terminals.push({ nodeId: reviewId, outcome: REVIEW_REJECTED_OUTCOME });
        else edges.push({ edgeId: ids.rejected, from: reviewId, when: { outcome: REVIEW_REJECTED_OUTCOME }, to: [target] });
      }
      if (rework) {
        edges.push({ edgeId: ids.reworkOut, from: reworkId, when: { anyOf: [...outcomes] }, to: [reviewId] });
      }
    }
  }
  return {
    graphId: graph.graphId,
    version: graph.version,
    description: graph.description,
    entry: approved.get(graph.entry) ?? graph.entry,
    nodes,
    edges,
    terminals
  };
}

/**
 * Expand a node-validated draft (or re-expand a sealed graph). A synthesized
 * id present in the input must equal its derivation; anything else under a
 * reserved id fails loudly instead of being silently replaced.
 */
export function normalizeApprovalReview(graph: GraphBase): GraphBase {
  const expanded = expand(unexpand(graph));
  const expectedNodes = new Map(expanded.nodes.map((node) => [node.nodeId, node]));
  const expectedEdges = new Map(expanded.edges.map((edge) => [edge.edgeId, edge]));
  for (const subject of graph.nodes) {
    if (approvalOf(subject) === undefined && reviewOf(subject) === undefined) continue;
    const ids = reservedIds(subject);
    for (const id of ids.nodes) {
      const present = graph.nodes.find((node) => node.nodeId === id);
      if (present === undefined) continue;
      const expected = expectedNodes.get(id);
      if (expected === undefined || canonicalJson(present) !== canonicalJson(expected)) {
        throw new Error(
          `Graph node ${id} is reserved for the settings of node ${subject.nodeId} and differs from its expansion; remove it or rename it`
        );
      }
    }
    for (const id of ids.edges) {
      const present = graph.edges.find((edge) => edge.edgeId === id);
      if (present === undefined) continue;
      const expected = expectedEdges.get(id);
      if (expected === undefined || canonicalJson(present) !== canonicalJson(expected)) {
        throw new Error(
          `Graph edge ${id} is reserved for the settings of node ${subject.nodeId} and differs from its expansion; remove it or rename it`
        );
      }
    }
  }
  return expanded;
}

export type ApprovalReviewRoleKind = "approval" | "subject" | "review" | "rework";

export interface ApprovalReviewRole {
  readonly role: ApprovalReviewRoleKind;
  readonly nodeId: string;
  /** The sealed (authored) subject node that carries the settings. */
  readonly subject: SwitchyardNode;
}

/**
 * The part a node plays in an approval/review expansion of a sealed graph,
 * or undefined for a node with no settings and no synthesized origin.
 */
export function approvalReviewRole(
  graph: Pick<GraphDefinition, "nodes">,
  nodeId: string
): ApprovalReviewRole | undefined {
  for (const subject of graph.nodes) {
    const approval = approvalOf(subject) !== undefined;
    const review = reviewOf(subject);
    if (!approval && review === undefined) continue;
    let role: ApprovalReviewRoleKind | undefined;
    if (nodeId === subject.nodeId) role = "subject";
    else if (approval && nodeId === approvalNodeId(subject.nodeId)) role = "approval";
    else if (review !== undefined && nodeId === reviewNodeId(subject.nodeId)) role = "review";
    else if (review !== undefined && reviewHasRework(review) && nodeId === reworkNodeId(subject.nodeId)) role = "rework";
    if (role !== undefined) return Object.freeze({ role, nodeId, subject });
  }
  return undefined;
}

/**
 * Review loops bounded by `maxRounds`: the back edge from the rework twin to
 * the review node is a structural cycle whose traversal count is sealed.
 */
export function boundedReviewLoops(
  nodes: readonly SwitchyardNode[]
): ReadonlyMap<string, { readonly subjectId: string; readonly reworkId: string; readonly edgeId: string; readonly maxRounds: number }> {
  const loops = new Map<string, { subjectId: string; reworkId: string; edgeId: string; maxRounds: number }>();
  for (const node of nodes) {
    const review = reviewOf(node);
    if (review === undefined || isRetry(review.onReject) || !reviewHasRework(review)) continue;
    loops.set(reviewNodeId(node.nodeId), {
      subjectId: node.nodeId,
      reworkId: reworkNodeId(node.nodeId),
      edgeId: approvalReviewEdgeIds(node.nodeId).reworkOut,
      maxRounds: review.maxRounds!
    });
  }
  return loops;
}
