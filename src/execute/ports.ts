// execute/ports.ts — strict host ports for one v2 node turn.
//
// These are capability seams, not implementations. Mission Pipeline supplies
// a minimal, frozen context and an already contract-validated input payload;
// hosts bind the code/model/agent bodies and the authenticated human/callback
// completion paths. No port receives graph routing, store, lease-token,
// credential, unit-admission, timer, or unit-spawning authority.

import { types as nodeTypes } from "node:util";

import {
  snapshotArtifactValidationData,
  validateArtifactEnvelope,
  validateArtifactRef,
  type ArtifactEnvelope,
  type ArtifactRef
} from "../contracts/artifact.js";
import {
  validateUsageReceipt,
  type UsageReceipt
} from "../contracts/usage-receipt.js";
import {
  declaredNodeOutput,
  validateMissionPipelineNodeConfigurationRef,
  type GraphDefinitionRef,
  type MissionPipelineNode,
  type MissionPipelineNodeBindingRef,
  type MissionPipelineNodeConfigurationRef,
  type MissionPipelineNodeKind,
  type MissionPipelineNodeRef
} from "../graph/definition.js";
import { snapshotGraphValidationData } from "../graph/limits.js";
import {
  assertIdentifier,
  assertPlainObject,
  assertRequiredKeys,
  assertSafePositiveInt,
  assertSha256Hex,
  assertStrictKeys,
  isPlainObject,
  typeName
} from "../internal/guards.js";
import {
  assertEvidenceString,
  deepFrozenClone
} from "../internal/evidence.js";
import { captureCapabilityRecord } from "../internal/capability.js";
import { validateMissionPipelineNode } from "../graph/definition.js";

export const MAX_AGENT_TURN_USAGE_RECEIPTS = 256;
export const ENGINE_JOIN_UNSATISFIABLE_OUTCOME = "join_unsatisfiable" as const;

/** Minimal immutable attempt context visible to a worker-side node body. */
export interface WorkerNodeTurnContext {
  readonly graph: GraphDefinitionRef;
  /** Durable identity of this particular queued occurrence. */
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly nodeRef: MissionPipelineNodeRef;
  readonly attemptNumber: number;
  /** 1-based retry ordinal within this queue occurrence. */
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
  /** Content identity only; the validated payload is the port's first argument. */
  readonly inputArtifact: ArtifactRef;
  /** The sealed configuration this node runs under, when the graph declares one. */
  readonly configuration?: MissionPipelineNodeConfigurationRef;
  readonly signal?: AbortSignal;
}

/** Canonical ordinary host completion. Routing remains engine-owned. */
export interface NodeTurnCompletion {
  readonly outcome: string;
  readonly outputArtifact?: ArtifactEnvelope;
  readonly usage?: readonly UsageReceipt[];
}

export interface UnmeteredNodeTurnCompletion extends NodeTurnCompletion {
  readonly usage?: never;
}

export interface ModelNodeTurnCompletion extends NodeTurnCompletion {
  /** A model turn records exactly one validated receipt. */
  readonly usage: readonly [UsageReceipt];
}

export interface AgentNodeTurnCompletion extends NodeTurnCompletion {
  /** Agent receipt collection is explicit and bounded; omission means none. */
  readonly usage?: readonly UsageReceipt[];
}

export type NodePortCompletion<K extends MissionPipelineNodeKind> =
  K extends "model"
    ? ModelNodeTurnCompletion
    : K extends "agent"
      ? AgentNodeTurnCompletion
      : UnmeteredNodeTurnCompletion;

/**
 * Opaque two-stage completion snapshot. `usage` is validated first so a turn
 * executor can durably collect billable evidence before it validates the
 * ordinary outcome/artifact fields. Callers cannot forge a trusted snapshot.
 */
export interface NodeTurnCompletionSnapshot {
  readonly value: Readonly<Record<string, unknown>>;
  readonly usage: readonly UsageReceipt[];
  readonly hasUsage: boolean;
}

const completionSnapshots = new WeakSet<object>();
const COMPLETION_KEYS = new Set(["outcome", "outputArtifact", "usage"]);
const COMPLETION_REQUIRED_KEYS = new Set(["outcome"]);

/** Base typed failure carrying every receipt validated before ordinary output failed. */
export class NodeTurnCompletionError extends Error {
  readonly usage: readonly UsageReceipt[];

  constructor(name: string, message: string, usage: readonly UsageReceipt[], cause: unknown) {
    super(message, { cause });
    this.name = name;
    // Subclasses that expose this as trusted evidence validate it before
    // branding. Do not iterate caller-owned input in this base constructor.
    this.usage = usage;
  }
}

/** Descriptor/detachment failure after receipt-first extraction. */
export class NodeTurnCompletionSnapshotError extends NodeTurnCompletionError {
  constructor(message: string, usage: readonly UsageReceipt[], cause: unknown) {
    super("NodeTurnCompletionSnapshotError", message, usage, cause);
  }
}

/** Outcome/artifact/node-contract failure after receipt-first extraction. */
export class NodeTurnCompletionValidationError extends NodeTurnCompletionError {
  constructor(message: string, usage: readonly UsageReceipt[], cause: unknown) {
    super("NodeTurnCompletionValidationError", message, usage, cause);
  }
}

function safeValidationMessage(error: unknown, fallback: string): string {
  if (
    error === null
    || (typeof error !== "object" && typeof error !== "function")
    || nodeTypes.isProxy(error)
  ) return fallback;
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  return descriptor !== undefined
    && "value" in descriptor
    && typeof descriptor.value === "string"
    ? descriptor.value
    : fallback;
}

function snapshotUsageReceipts(
  value: unknown,
  label: string
): readonly UsageReceipt[] {
  const accepted: UsageReceipt[] = [];
  try {
    if (
      !Array.isArray(value)
      || nodeTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype
    ) {
      throw new Error(`${label}: must be a plain non-Proxy dense array of usage-receipt.v1`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined
      || !("value" in lengthDescriptor)
      || typeof lengthDescriptor.value !== "number"
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw new Error(`${label}.length must be a non-negative safe-integer data property`);
    }
    const length = lengthDescriptor.value;
    if (length > MAX_AGENT_TURN_USAGE_RECEIPTS) {
      throw new Error(
        `${label}: at most ${MAX_AGENT_TURN_USAGE_RECEIPTS} receipts are allowed (got ${length})`
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.hasOwn(descriptors, String(index))
        ? descriptors[String(index)]
        : undefined;
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.enumerable !== true
      ) {
        throw new Error(`${label}[${index}] must be an enumerable data property`);
      }
      accepted.push(
        deepFrozenClone(
          validateUsageReceipt(descriptor.value),
          `${label}[${index}]`
        )
      );
    }
    const allowedKeys = new Set([
      "length",
      ...Array.from({ length }, (_, index) => String(index))
    ]);
    const extras = Reflect.ownKeys(descriptors).filter(
      (key) => typeof key !== "string" || !allowedKeys.has(key)
    );
    if (extras.length > 0) {
      throw new Error(`${label} must be dense and have no unsupported extra keys`);
    }
    return Object.freeze(accepted);
  } catch (error) {
    Object.freeze(accepted);
    throw new NodeTurnCompletionSnapshotError(
      safeValidationMessage(error, `${label}: usage snapshot failed`),
      accepted,
      error
    );
  }
}

/**
 * Descriptor-safely snapshot an untrusted port result exactly once, then
 * extract and validate usage before any outcome or artifact interpretation.
 */
export function snapshotNodeTurnCompletion(
  value: unknown,
  label = "node turn completion"
): NodeTurnCompletionSnapshot {
  if (
    value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || !isPlainObject(value)
  ) {
    throw new Error(`${label}: must be a plain non-Proxy object (got ${typeName(value)})`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const descriptorKeys = Reflect.ownKeys(descriptors);

  const usageDescriptor = Object.hasOwn(descriptors, "usage")
    ? descriptors.usage
    : undefined;
  const hasUsage = usageDescriptor !== undefined;
  let usage: readonly UsageReceipt[] = Object.freeze([]);
  if (hasUsage) {
    if (!("value" in usageDescriptor) || usageDescriptor.enumerable !== true) {
      throw new NodeTurnCompletionSnapshotError(
        `${label}.usage must be an enumerable data property`,
        usage,
        undefined
      );
    }
    usage = snapshotUsageReceipts(usageDescriptor.value, `${label}.usage`);
  }

  try {
    for (const key of descriptorKeys) {
      if (typeof key !== "string") {
        throw new Error(`${label} has symbol keys`);
      }
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        throw new Error(`${label}.${key} must be an enumerable data property`);
      }
    }
    const unknown = descriptorKeys.filter(
      (key): key is string => typeof key === "string" && !COMPLETION_KEYS.has(key)
    );
    if (unknown.length > 0) {
      throw new Error(
        `${label}: unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(", ")} (strict object — allowed: ${[...COMPLETION_KEYS].join(", ")})`
      );
    }
    // Missing required/optional fields must stay missing even if ambient
    // Object.prototype has been poisoned by unrelated host code.
    const raw = Object.create(null) as Record<string, unknown>;
    const outcomeDescriptor = Object.hasOwn(descriptors, "outcome")
      ? descriptors.outcome
      : undefined;
    if (outcomeDescriptor !== undefined) {
      Object.defineProperty(raw, "outcome", {
        configurable: false,
        enumerable: true,
        writable: false,
        value: snapshotGraphValidationData(
          outcomeDescriptor.value,
          `${label}.outcome`
        )
      });
    }
    const outputArtifactDescriptor = Object.hasOwn(descriptors, "outputArtifact")
      ? descriptors.outputArtifact
      : undefined;
    if (outputArtifactDescriptor !== undefined) {
      Object.defineProperty(raw, "outputArtifact", {
        configurable: false,
        enumerable: true,
        writable: false,
        // Artifact envelopes own their wider hostile-data budget. Reusing the
        // graph snapshot budget here would silently narrow that public contract.
        value: snapshotArtifactValidationData(
          outputArtifactDescriptor.value,
          `${label}.outputArtifact`
        )
      });
    }
    if (hasUsage) {
      Object.defineProperty(raw, "usage", {
        configurable: false,
        enumerable: true,
        writable: false,
        value: usage
      });
    }
    Object.freeze(raw);
    const result = Object.freeze({ value: raw, usage, hasUsage });
    completionSnapshots.add(result);
    return result;
  } catch (error) {
    throw new NodeTurnCompletionSnapshotError(
      safeValidationMessage(error, `${label}: completion snapshot failed`),
      usage,
      error
    );
  }
}

function asCompletionSnapshot(
  value: unknown | NodeTurnCompletionSnapshot,
  label: string
): NodeTurnCompletionSnapshot {
  if (
    value !== null
    && typeof value === "object"
    && completionSnapshots.has(value)
  ) {
    return value as NodeTurnCompletionSnapshot;
  }
  return snapshotNodeTurnCompletion(value, label);
}

/**
 * Validate an ordinary host result against the exact node contract.
 * `join_unsatisfiable` is engine-produced and can never be claimed by a host
 * body. Extra routing/spawn/timer keys fail under the closed result shape.
 */
export function validateNodeTurnCompletion<K extends MissionPipelineNodeKind>(
  nodeRaw: MissionPipelineNode & { readonly kind: K },
  value: unknown | NodeTurnCompletionSnapshot,
  label = "node turn completion"
): NodePortCompletion<K> {
  const completion = asCompletionSnapshot(value, label);
  try {
    const node = validateMissionPipelineNode(nodeRaw, `${label}: node`) as MissionPipelineNode & {
      readonly kind: K;
    };
    const raw = completion.value;

    assertStrictKeys(raw as Record<string, unknown>, COMPLETION_KEYS, label);
    assertRequiredKeys(raw as Record<string, unknown>, COMPLETION_REQUIRED_KEYS, label);

    if (node.kind === "model") {
      if (!completion.hasUsage || completion.usage.length !== 1) {
        throw new Error(
          `${label}: model node ${node.nodeId} must return exactly one usage receipt (got ${completion.hasUsage ? completion.usage.length : "none"})`
        );
      }
    } else if (node.kind === "agent") {
      // Explicit 0..256 collection is admitted and already validated above.
    } else if (completion.hasUsage) {
      throw new Error(
        `${label}: ${node.kind} node ${node.nodeId} must not return usage receipts`
      );
    }

    const outcome = assertIdentifier(raw.outcome, `${label}: outcome`);
    if (outcome === ENGINE_JOIN_UNSATISFIABLE_OUTCOME) {
      throw new Error(
        `${label}: node ${node.nodeId} outcome ${JSON.stringify(outcome)} is engine-reserved and cannot be returned by a host port`
      );
    }
    if (!node.outcomes.outcomes.includes(outcome)) {
      throw new Error(
        `${label}: node ${node.nodeId} returned undeclared outcome ${JSON.stringify(outcome)}`
      );
    }

    let outputArtifact: ArtifactEnvelope | undefined;
    if (Object.hasOwn(raw, "outputArtifact")) {
      if (raw.outputArtifact === undefined) {
        throw new Error(`${label}.outputArtifact is present but undefined (omit the key instead)`);
      }
      outputArtifact = validateArtifactEnvelope(raw.outputArtifact);
    }
    if (node.kind === "callback" && outputArtifact === undefined) {
      throw new Error(
        `${label}: callback node ${node.nodeId} must return outputArtifact for the admitted event`
      );
    }
    // A declared output contract binds the artifact this outcome carries
    // onward: the returned artifact, or the input carried forward when none
    // is returned. Settlement re-checks every target's input; this check keeps
    // the host's own declaration honest before the completion is cached.
    const declared = declaredNodeOutput(node, outcome);
    if (declared !== undefined) {
      const carried = outputArtifact === undefined ? node.input : outputArtifact.contractId;
      if (carried !== declared) {
        throw new Error(
          `${label}: node ${node.nodeId} outcome ${JSON.stringify(outcome)} must carry ${declared} (got ${carried}${outputArtifact === undefined ? ", the input carried forward" : ""})`
        );
      }
    }

    return deepFrozenClone(
      {
        outcome,
        ...(outputArtifact === undefined ? {} : { outputArtifact }),
        ...(completion.hasUsage ? { usage: completion.usage } : {})
      },
      label
    ) as NodePortCompletion<K>;
  } catch (error) {
    if (error instanceof NodeTurnCompletionError) throw error;
    throw new NodeTurnCompletionValidationError(
      safeValidationMessage(error, `${label}: completion validation failed`),
      completion.usage,
      error
    );
  }
}

/** Alias emphasizing that the validated value came from a host port. */
export const snapshotNodePortResult: typeof validateNodeTurnCompletion =
  validateNodeTurnCompletion;

const CONTEXT_KEYS = [
  "graph",
  "queueId",
  "unitId",
  "nodeId",
  "nodeRef",
  "attemptNumber",
  "attemptIndex",
  "idempotencyKey",
  "inputArtifact",
  "configuration",
  "signal"
] as const;
const CONTEXT_REQUIRED_KEYS = CONTEXT_KEYS.filter(
  (key) => key !== "signal" && key !== "configuration"
);
const GRAPH_REF_KEYS = new Set(["id", "version", "digest"]);
const NODE_REF_KEYS = new Set(["id", "version"]);

function frozenNullRecord<T extends object>(value: T): T {
  return Object.freeze(
    Object.assign(Object.create(null) as object, value)
  ) as T;
}

function snapshotGraphRef(value: unknown, label: string): GraphDefinitionRef {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, GRAPH_REF_KEYS, label);
  assertRequiredKeys(raw, GRAPH_REF_KEYS, label);
  return frozenNullRecord({
    id: assertIdentifier(raw.id, `${label}.id`),
    version: assertSafePositiveInt(raw.version, `${label}.version`),
    digest: assertSha256Hex(raw.digest, `${label}.digest`)
  });
}

function snapshotNodeRef(value: unknown, label: string): MissionPipelineNodeRef {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, NODE_REF_KEYS, label);
  assertRequiredKeys(raw, NODE_REF_KEYS, label);
  return frozenNullRecord({
    id: assertIdentifier(raw.id, `${label}.id`),
    version: assertSafePositiveInt(raw.version, `${label}.version`)
  });
}

/** Capture a caller-owned worker context without invoking accessors. */
export function snapshotWorkerNodeTurnContext(
  value: unknown,
  label = "worker node turn context"
): WorkerNodeTurnContext {
  const raw = captureCapabilityRecord(
    value,
    CONTEXT_KEYS,
    CONTEXT_REQUIRED_KEYS,
    label
  );
  const signal = raw.signal;
  if (
    signal !== undefined
    && (
      signal === null
      || typeof signal !== "object"
      || nodeTypes.isProxy(signal)
      || Object.getPrototypeOf(signal) !== AbortSignal.prototype
    )
  ) {
    throw new Error(`${label}.signal must be a non-Proxy AbortSignal`);
  }
  const validatedInputArtifact = validateArtifactRef(raw.inputArtifact);
  const inputArtifact = frozenNullRecord({
    contractId: validatedInputArtifact.contractId,
    digest: validatedInputArtifact.digest,
    ...(Object.hasOwn(validatedInputArtifact, "bytes")
      ? { bytes: validatedInputArtifact.bytes }
      : {})
  });
  let configuration: MissionPipelineNodeConfigurationRef | undefined;
  if (Object.hasOwn(raw, "configuration")) {
    if (raw.configuration === undefined) {
      throw new Error(`${label}.configuration is present but undefined (omit the key instead)`);
    }
    const validated = validateMissionPipelineNodeConfigurationRef(
      raw.configuration,
      `${label}.configuration`
    );
    configuration = frozenNullRecord({
      id: validated.id,
      version: validated.version,
      digest: validated.digest
    });
  }
  const context: WorkerNodeTurnContext = frozenNullRecord({
    graph: snapshotGraphRef(raw.graph, `${label}.graph`),
    queueId: assertEvidenceString(raw.queueId, `${label}.queueId`),
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
    nodeRef: snapshotNodeRef(raw.nodeRef, `${label}.nodeRef`),
    attemptNumber: assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`),
    attemptIndex: assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`),
    idempotencyKey: assertSha256Hex(raw.idempotencyKey, `${label}.idempotencyKey`),
    inputArtifact,
    ...(configuration === undefined ? {} : { configuration }),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal })
  });
  return context;
}

/** In-process body; adapters can pass `input` directly to an existing Stage.run. */
export interface CodeNodePort {
  readonly run: (
    input: unknown,
    context: WorkerNodeTurnContext
  ) => Promise<UnmeteredNodeTurnCompletion>;
}

/** Provider-facing model attempt; binding resolution and journaling stay host-side. */
export interface ModelNodePort {
  readonly invoke: (
    input: unknown,
    binding: MissionPipelineNodeBindingRef,
    context: WorkerNodeTurnContext
  ) => Promise<ModelNodeTurnCompletion>;
}

/** Structural asynchronous agent turn port; the stable context keys both calls. */
export interface AgentNodePort {
  readonly submitTurnIntent: (
    input: unknown,
    context: WorkerNodeTurnContext
  ) => Promise<void>;
  readonly awaitSettledResult: (
    context: WorkerNodeTurnContext
  ) => Promise<AgentNodeTurnCompletion>;
}

/** Audit attribution only. It is deliberately not an authorization grant. */
export interface NodeTurnActorAttribution {
  readonly actorId: string;
}

export interface HumanNodeDecision {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly outcome: string;
  readonly outputArtifact?: ArtifactEnvelope;
  readonly actor: NodeTurnActorAttribution;
}

export interface CallbackNodeEvent {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly outcome: string;
  readonly outputArtifact: ArtifactEnvelope;
  readonly actor: NodeTurnActorAttribution;
}

/**
 * Human and callback implementations receive authenticated authority as a
 * separate host-owned capability argument. A caller-authored actorId is only
 * journey attribution and can never satisfy the principal check by itself.
 */
export interface HumanNodePort<TAuthenticatedPrincipal = unknown> {
  readonly recordDecision: (
    decision: HumanNodeDecision,
    authenticatedPrincipal: TAuthenticatedPrincipal
  ) => Promise<void>;
}

export interface CallbackNodePort<TAuthenticatedPrincipal = unknown> {
  readonly admitEvent: (
    event: CallbackNodeEvent,
    authenticatedPrincipal: TAuthenticatedPrincipal
  ) => Promise<void>;
}
