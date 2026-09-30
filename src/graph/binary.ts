// graph/binary.ts — binary-first questions with explicit escalation.
//
// A small model is most reliable on one narrow yes/no question, provided it
// may say it does not know. `binaryQuestion` builds that as an ordinary draft
// fragment: a model node with outcomes `yes | no | unsure` whose `unsure`
// carries the unchanged input to the next tier — a bigger model, a person, or
// both in order (the same `SwitchyardActor` shape as approval and review).
// Every tier but the last may also answer `unsure`; the last must decide.
// `yes` and `no` from every tier route to the same place.

import type { ContractId } from "../contracts/artifact.js";
import {
  validateSwitchyardActor,
  validateSwitchyardNode,
  type PrincipalRef,
  type SwitchyardActor,
  type SwitchyardNode,
  type SwitchyardNodeBindingRef,
  type SwitchyardNodeConfigurationRef,
  type SwitchyardNodeRef,
  type SwitchyardNodeTurn,
  type TerminalOutcome
} from "./definition.js";
import { validateEdge, type Edge } from "./edge.js";
import { deepFrozenClone } from "../internal/evidence.js";
import { assertIdentifier } from "../internal/guards.js";

export const SWITCHYARD_BINARY_OUTCOMES = Object.freeze(["yes", "no", "unsure"] as const);
export const MAX_BINARY_ESCALATION_TIERS = 4;

export type BinaryRoute = "terminal" | { readonly to: string };

export interface BinaryQuestionInput {
  readonly nodeId: string;
  readonly ref: SwitchyardNodeRef;
  readonly input: ContractId;
  readonly principal: PrincipalRef;
  readonly binding: SwitchyardNodeBindingRef;
  readonly turn: SwitchyardNodeTurn;
  readonly configuration?: SwitchyardNodeConfigurationRef;
  /** Who is asked after `unsure`, in order. The last tier must answer yes or no. */
  readonly escalate: SwitchyardActor | readonly SwitchyardActor[];
  readonly yes: BinaryRoute;
  readonly no: BinaryRoute;
}

export interface BinaryQuestionFragment {
  readonly nodes: readonly SwitchyardNode[];
  readonly edges: readonly Edge[];
  readonly terminals: readonly TerminalOutcome[];
  /** Node ids of the escalation tiers, in the order they are asked. */
  readonly tiers: readonly string[];
}

/** Node id of the `tier`-th (1-based) escalation of a binary question. */
export function binaryEscalationNodeId(nodeId: string, tier: number): string {
  return `${nodeId}.escalate-${tier}`;
}

function routeOf(value: unknown, label: string): BinaryRoute {
  if (value === "terminal") return "terminal";
  if (value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.hasOwn(value, "to")) {
    return { to: assertIdentifier((value as { to: unknown }).to, `${label}.to`) };
  }
  throw new Error(`${label}: must be "terminal" or { to: nodeId }`);
}

/**
 * Build the nodes, edges and terminals of one binary-first question, to be
 * spread into a graph draft. Tier nodes are ordinary authored nodes, so they
 * may themselves carry approval or review settings after the fact.
 */
export function binaryQuestion(input: BinaryQuestionInput): BinaryQuestionFragment {
  const label = "binary question";
  const actors = (Array.isArray(input.escalate) ? input.escalate : [input.escalate])
    .map((actor, index) => validateSwitchyardActor(actor, `${label}.escalate[${index}]`));
  if (actors.length < 1 || actors.length > MAX_BINARY_ESCALATION_TIERS) {
    throw new Error(`${label}.escalate: must name 1..${MAX_BINARY_ESCALATION_TIERS} tiers`);
  }
  const yes = routeOf(input.yes, `${label}.yes`);
  const no = routeOf(input.no, `${label}.no`);
  const small = validateSwitchyardNode({
    nodeId: input.nodeId,
    ref: input.ref,
    kind: "model",
    input: input.input,
    outcomes: { version: input.ref.version, outcomes: [...SWITCHYARD_BINARY_OUTCOMES] },
    outputs: { unsure: input.input },
    principal: input.principal,
    binding: input.binding,
    ...(input.configuration === undefined ? {} : { configuration: input.configuration }),
    turn: input.turn
  }, label);
  const nodes: SwitchyardNode[] = [small];
  const edges: Edge[] = [];
  const terminals: TerminalOutcome[] = [];
  const answer = (from: string): void => {
    for (const [outcome, route] of [["yes", yes], ["no", no]] as const) {
      if (route === "terminal") terminals.push({ nodeId: from, outcome });
      else edges.push(validateEdge({ edgeId: `${from}.${outcome}`, from, when: { outcome }, to: [route.to] }));
    }
  };
  answer(small.nodeId);
  let previous = small.nodeId;
  const tiers: string[] = [];
  actors.forEach((actor, index) => {
    const last = index === actors.length - 1;
    const nodeId = binaryEscalationNodeId(small.nodeId, index + 1);
    const node = validateSwitchyardNode({
      nodeId,
      ref: { id: `${small.ref.id}.escalate-${index + 1}.${actor.kind}${last ? "" : ".unsure"}`, version: small.ref.version },
      kind: actor.kind,
      input: small.input,
      outcomes: { version: small.ref.version, outcomes: last ? ["yes", "no"] : [...SWITCHYARD_BINARY_OUTCOMES] },
      ...(last ? {} : { outputs: { unsure: small.input } }),
      principal: actor.principal,
      ...(actor.kind === "model" ? { binding: actor.binding } : {}),
      turn: small.turn
    }, `${label} tier ${index + 1}`);
    nodes.push(node);
    tiers.push(nodeId);
    edges.push(validateEdge({ edgeId: `${previous}.unsure`, from: previous, when: { outcome: "unsure" }, to: [nodeId] }));
    answer(nodeId);
    previous = nodeId;
  });
  return deepFrozenClone({ nodes, edges, terminals, tiers }, label);
}
