// execute/turn.ts — one physical v2 node-turn attempt.
//
// This module owns the stable attempt identity and worker-kind dispatch. It is
// intentionally unaware of queues, joins, routing, leases, stores, providers,
// credentials, and unit admission. The unit runner supplies an already sealed
// input artifact and later asks the store to settle the validated completion.

import type { ArtifactEnvelope, ArtifactRef } from "../contracts/artifact.js";
import { validateArtifactEnvelope, validateArtifactRef } from "../contracts/artifact.js";
import { digest } from "../contracts/digest.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";
import {
  validateMissionPipelineNode,
  type MissionPipelineNode,
  type MissionPipelineNodeRef
} from "../graph/definition.js";
import {
  assertIdentifier,
  assertSafePositiveInt,
  assertSha256Hex
} from "../internal/guards.js";
import {
  captureCapabilityMethod,
  captureCapabilityRecord
} from "../internal/capability.js";
import {
  assertEvidenceString,
  deepFrozenClone
} from "../internal/evidence.js";
import {
  ExecutionFailureError,
  isExecutionFailureError
} from "./failure.js";
import {
  snapshotNodeTurnCompletion,
  snapshotWorkerNodeTurnContext,
  validateNodeTurnCompletion,
  type AgentNodePort,
  type CodeNodePort,
  type ModelNodePort,
  type NodeTurnCompletion,
  type NodeTurnCompletionSnapshot,
  type WorkerNodeTurnContext
} from "./ports.js";

export const NODE_EXECUTION_CONFIGURATION_FINGERPRINT = "default" as const;

export interface NodeTurnIdempotencyInput {
  readonly unitId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly nodeRef: MissionPipelineNodeRef;
  readonly fingerprint: string;
  readonly inputDigest: string;
  readonly executionIdentityDigest?: string;
}

const IDEMPOTENCY_KEYS = [
  "unitId",
  "nodeId",
  "attemptNumber",
  "nodeRef",
  "fingerprint",
  "inputDigest",
  "executionIdentityDigest"
] as const;
const IDEMPOTENCY_REQUIRED_KEYS = IDEMPOTENCY_KEYS.filter(
  (key) => key !== "executionIdentityDigest"
);
const NODE_REF_KEYS = new Set(["id", "version"]);

function frozenNullRecord<T extends object>(value: T): T {
  return Object.freeze(
    Object.assign(Object.create(null) as object, value)
  ) as T;
}

function validateNodeRef(value: unknown, label: string): MissionPipelineNodeRef {
  const raw = captureCapabilityRecord(
    value,
    [...NODE_REF_KEYS],
    [...NODE_REF_KEYS],
    label
  );
  return Object.freeze({
    id: assertIdentifier(raw.id, `${label}.id`),
    version: assertSafePositiveInt(raw.version, `${label}.version`)
  });
}

/** The exact below-N0 fingerprint formula recorded in the phase plan. */
export function nodeExecutionFingerprint(nodeRaw: unknown): string {
  const node = validateMissionPipelineNode(nodeRaw, "node execution fingerprint");
  const binding = Object.hasOwn(node, "binding") ? node.binding : undefined;
  return digest({
    bindingFingerprint: binding?.bindingDigest ?? "none",
    configurationFingerprint: NODE_EXECUTION_CONFIGURATION_FINGERPRINT
  });
}

/**
 * Stable physical-attempt identity. Field names and optional-field omission are
 * binding: changing any included coordinate changes the digest.
 */
export function nodeTurnIdempotencyKey(inputRaw: unknown): string {
  const raw = captureCapabilityRecord(
    inputRaw,
    IDEMPOTENCY_KEYS,
    IDEMPOTENCY_REQUIRED_KEYS,
    "node turn idempotency input"
  );
  const nodeRef = validateNodeRef(raw.nodeRef, "node turn idempotency input.nodeRef");
  const executionIdentityDigest = raw.executionIdentityDigest === undefined
    ? undefined
    : assertSha256Hex(
        raw.executionIdentityDigest,
        "node turn idempotency input.executionIdentityDigest"
      );
  const input: NodeTurnIdempotencyInput = Object.freeze({
    unitId: assertEvidenceString(raw.unitId, "node turn idempotency input.unitId"),
    nodeId: assertIdentifier(raw.nodeId, "node turn idempotency input.nodeId"),
    attemptNumber: assertSafePositiveInt(
      raw.attemptNumber,
      "node turn idempotency input.attemptNumber"
    ),
    nodeRef,
    fingerprint: assertSha256Hex(
      raw.fingerprint,
      "node turn idempotency input.fingerprint"
    ),
    inputDigest: assertSha256Hex(
      raw.inputDigest,
      "node turn idempotency input.inputDigest"
    ),
    ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest })
  });
  return digest({
    unitId: input.unitId,
    nodeId: input.nodeId,
    attemptNumber: input.attemptNumber,
    nodeRef: input.nodeRef,
    fingerprint: input.fingerprint,
    inputDigest: input.inputDigest,
    ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest })
  });
}

function artifactRefFromEnvelope(envelope: ArtifactEnvelope): ArtifactRef {
  return validateArtifactRef({
    contractId: envelope.contractId,
    digest: envelope.digest,
    ...(Object.hasOwn(envelope, "bytes") ? { bytes: envelope.bytes } : {})
  });
}

/** Conflict seal for one validated completion under one attempt key. */
export function nodeTurnCompletionDigest(completionRaw: unknown): string {
  const completion = snapshotNodeTurnCompletion(
    completionRaw,
    "node turn completion digest input"
  );
  const raw = completion.value;
  const outcome = assertIdentifier(raw.outcome, "node turn completion digest input.outcome");
  let outputArtifact: ArtifactRef | undefined;
  if (Object.hasOwn(raw, "outputArtifact")) {
    if (raw.outputArtifact === undefined) {
      throw new Error(
        "node turn completion digest input.outputArtifact is present but undefined"
      );
    }
    outputArtifact = artifactRefFromEnvelope(
      validateArtifactEnvelope(raw.outputArtifact)
    );
  }
  const usage = completion.hasUsage ? completion.usage : undefined;
  return digest({
    outcome,
    ...(outputArtifact === undefined ? {} : { outputArtifact }),
    ...(usage === undefined ? {} : { usage })
  });
}

/** Engine-created marker for a returned value that failed completion validation. */
interface NodeTurnResultErrorEvidence {
  readonly nodeId: string;
  readonly idempotencyKey: string;
  readonly usage: readonly UsageReceipt[];
}

const nodeTurnResultErrorEvidenceByError =
  new WeakMap<object, NodeTurnResultErrorEvidence>();

class NodeTurnResultError extends ExecutionFailureError {
  readonly nodeId: string;
  readonly usage: readonly UsageReceipt[];

  constructor(
    nodeId: string,
    idempotencyKey: string,
    usage: readonly UsageReceipt[],
    cause: unknown
  ) {
    super("immutable_stage_contract_rejected", false, cause);
    this.name = "NodeTurnResultError";
    if (cause !== null && typeof cause === "object") {
      const message = Object.getOwnPropertyDescriptor(cause, "message");
      if (message !== undefined && "value" in message && typeof message.value === "string") {
        this.message = message.value;
      }
    }
    this.nodeId = nodeId;
    // Reuse the bounded receipt-first validator before branding evidence.
    this.usage = snapshotNodeTurnCompletion(
      { outcome: "invalid_result", usage },
      "invalid node turn result"
    ).usage;
    nodeTurnResultErrorEvidenceByError.set(this, Object.freeze({
      nodeId,
      idempotencyKey,
      usage: this.usage
    }));
    Object.freeze(this);
  }
}

/**
 * Receipt evidence captured by a branded result error for this exact physical
 * attempt. A real brand replayed from another node/attempt carries no
 * authority here.
 */
export function nodeTurnResultErrorUsage(
  value: unknown,
  nodeId: string,
  idempotencyKey: string
): readonly UsageReceipt[] | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const evidence = nodeTurnResultErrorEvidenceByError.get(value);
  return evidence?.nodeId === nodeId && evidence.idempotencyKey === idempotencyKey
    ? evidence.usage
    : undefined;
}

/** A worker claim exposed a human/callback wait to an executable worker. */
export class WorkerNodeKindError extends Error {
  readonly code = "worker_node_kind_rejected";
  readonly nodeId: string;

  constructor(nodeId: string, kind: string) {
    super(`worker runner cannot execute ${kind} node ${nodeId}`);
    this.name = "WorkerNodeKindError";
    this.nodeId = nodeId;
    Object.freeze(this);
  }
}

export type NodeTurnInvocationUncertainOperation = "agent_submit" | "agent_await";

export interface NodeTurnInvocationUncertain {
  readonly code: "node_turn_invocation_uncertain";
  readonly operation: NodeTurnInvocationUncertainOperation;
}

interface NodeTurnInvocationUncertainEvidence {
  readonly nodeId: string;
  readonly idempotencyKey: string;
}

const nodeTurnInvocationUncertainEvidenceByError =
  new WeakMap<object, NodeTurnInvocationUncertainEvidence>();

/**
 * An asynchronous agent intent may exist or may still complete. Retrying it
 * under a new physical-attempt key would be unsafe, so the reservation stays
 * unresolved until the host can recover the same keyed intent.
 */
class NodeTurnInvocationUncertainError extends Error
  implements NodeTurnInvocationUncertain {
  readonly code = "node_turn_invocation_uncertain" as const;
  readonly operation: NodeTurnInvocationUncertainOperation;

  constructor(
    operation: NodeTurnInvocationUncertainOperation,
    nodeId: string,
    idempotencyKey: string,
    cause: unknown
  ) {
    super(`Agent node-turn invocation is indeterminate: ${operation}`, { cause });
    this.name = "NodeTurnInvocationUncertainError";
    this.operation = operation;
    nodeTurnInvocationUncertainEvidenceByError.set(this, Object.freeze({
      nodeId,
      idempotencyKey
    }));
    Object.freeze(this);
  }
}

/** Brand check used at the runner boundary; safe for hostile thrown Proxies. */
export function isNodeTurnInvocationUncertainError(
  value: unknown,
  nodeId?: string,
  idempotencyKey?: string
): value is NodeTurnInvocationUncertain {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  const evidence = nodeTurnInvocationUncertainEvidenceByError.get(value);
  if (evidence === undefined) return false;
  if (nodeId === undefined && idempotencyKey === undefined) return true;
  return nodeId !== undefined
    && idempotencyKey !== undefined
    && evidence.nodeId === nodeId
    && evidence.idempotencyKey === idempotencyKey;
}

export interface WorkerNodePorts {
  readonly code?: CodeNodePort;
  readonly model?: ModelNodePort;
  readonly agent?: AgentNodePort;
}

export interface ExecuteNodeTurnAttemptInput {
  readonly node: MissionPipelineNode;
  readonly context: WorkerNodeTurnContext;
  readonly inputArtifact: ArtifactEnvelope;
  readonly ports: WorkerNodePorts;
  readonly executionIdentityDigest?: string;
}

function assertContextMatchesNode(
  node: MissionPipelineNode,
  context: WorkerNodeTurnContext,
  inputArtifact: ArtifactEnvelope,
  executionIdentityDigest: string | undefined
): void {
  if (context.nodeId !== node.nodeId) {
    throw new Error(
      `worker context nodeId ${context.nodeId} does not match sealed node ${node.nodeId}`
    );
  }
  if (
    context.nodeRef.id !== node.ref.id
    || context.nodeRef.version !== node.ref.version
  ) {
    throw new Error(
      `worker context nodeRef does not match sealed node ${node.ref.id}@${node.ref.version}`
    );
  }
  if (inputArtifact.contractId !== node.input) {
    throw new Error(
      `node ${node.nodeId} input contract mismatch: expected ${node.input}, got ${inputArtifact.contractId}`
    );
  }
  const contextHasBytes = Object.hasOwn(context.inputArtifact, "bytes");
  const inputHasBytes = Object.hasOwn(inputArtifact, "bytes");
  if (
    context.inputArtifact.contractId !== inputArtifact.contractId
    || context.inputArtifact.digest !== inputArtifact.digest
    || contextHasBytes !== inputHasBytes
    || (contextHasBytes && context.inputArtifact.bytes !== inputArtifact.bytes)
  ) {
    throw new Error(`worker context inputArtifact does not match node ${node.nodeId} input`);
  }
  const expectedKey = nodeTurnIdempotencyKey({
    unitId: context.unitId,
    nodeId: context.nodeId,
    attemptNumber: context.attemptNumber,
    nodeRef: context.nodeRef,
    fingerprint: nodeExecutionFingerprint(node),
    inputDigest: inputArtifact.digest,
    ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest })
  });
  if (context.idempotencyKey !== expectedKey) {
    throw new Error(
      `node ${node.nodeId} idempotency key mismatch: supplied ${context.idempotencyKey} != computed ${expectedKey}`
    );
  }
}

function captureCompletion(
  node: MissionPipelineNode,
  idempotencyKey: string,
  rawResult: unknown
): NodeTurnCompletion {
  let snapshot: NodeTurnCompletionSnapshot;
  try {
    snapshot = snapshotNodeTurnCompletion(
      rawResult,
      `node ${node.nodeId} completion`
    );
  } catch (error) {
    // A receipt-first snapshot error may expose a validated usage collection;
    // read it descriptor-only and otherwise retain an empty collection.
    let usage: readonly UsageReceipt[] = Object.freeze([]);
    if (error !== null && typeof error === "object") {
      const descriptor = Object.getOwnPropertyDescriptor(error, "usage");
      if (descriptor !== undefined && "value" in descriptor && Array.isArray(descriptor.value)) {
        try {
          usage = deepFrozenClone(
            descriptor.value,
            `node ${node.nodeId} invalid completion usage`
          ) as readonly UsageReceipt[];
        } catch {
          usage = Object.freeze([]);
        }
      }
    }
    throw new NodeTurnResultError(node.nodeId, idempotencyKey, usage, error);
  }
  try {
    return validateNodeTurnCompletion(
      node,
      snapshot,
      `node ${node.nodeId} completion`
    );
  } catch (error) {
    throw new NodeTurnResultError(
      node.nodeId,
      idempotencyKey,
      snapshot.usage,
      error
    );
  }
}

function capturePortMethod(
  port: unknown,
  key: string,
  label: string
): (...args: any[]) => any {
  try {
    return captureCapabilityMethod(port, key, label);
  } catch (error) {
    throw new ExecutionFailureError(
      "immutable_configuration_rejected",
      false,
      error
    );
  }
}

/**
 * Invoke exactly one worker-executable node attempt. Human and callback nodes
 * are rejected before any capability lookup or invocation.
 */
export async function executeNodeTurnAttempt(
  inputRaw: ExecuteNodeTurnAttemptInput
): Promise<NodeTurnCompletion> {
  const raw = captureCapabilityRecord(
    inputRaw,
    ["node", "context", "inputArtifact", "ports", "executionIdentityDigest"],
    ["node", "context", "inputArtifact", "ports"],
    "executeNodeTurnAttempt input"
  );
  const node = validateMissionPipelineNode(raw.node, "executeNodeTurnAttempt node");
  if (node.kind === "human" || node.kind === "callback") {
    throw new WorkerNodeKindError(node.nodeId, node.kind);
  }
  const context = snapshotWorkerNodeTurnContext(raw.context);
  const inputArtifact = validateArtifactEnvelope(raw.inputArtifact);
  const executionIdentityDigest = raw.executionIdentityDigest === undefined
    ? undefined
    : assertSha256Hex(
        raw.executionIdentityDigest,
        "executeNodeTurnAttempt input.executionIdentityDigest"
      );
  assertContextMatchesNode(node, context, inputArtifact, executionIdentityDigest);

  let ports: Readonly<Record<string, unknown>>;
  try {
    ports = captureCapabilityRecord(
      raw.ports,
      ["code", "model", "agent"],
      [],
      "worker node ports"
    );
  } catch (error) {
    throw new ExecutionFailureError(
      "immutable_configuration_rejected",
      false,
      error
    );
  }
  const port = ports[node.kind];
  if (port === undefined) {
    throw new ExecutionFailureError(
      "immutable_configuration_rejected",
      false,
      new Error(`worker node ports.${node.kind} is required for node ${node.nodeId}`)
    );
  }

  let result: unknown;
  if (node.kind === "code") {
    const run = capturePortMethod(port, "run", "code node port");
    result = await run(inputArtifact.payload, context);
  } else if (node.kind === "model") {
    const binding = Object.hasOwn(node, "binding") ? node.binding : undefined;
    if (binding === undefined) {
      throw new ExecutionFailureError(
        "immutable_configuration_rejected",
        false,
        new Error(`model node ${node.nodeId} requires a sealed model binding`)
      );
    }
    const invoke = capturePortMethod(port, "invoke", "model node port");
    result = await invoke(
      inputArtifact.payload,
      frozenNullRecord({
        kind: binding.kind,
        bindingId: binding.bindingId,
        version: binding.version,
        bindingDigest: binding.bindingDigest
      }),
      context
    );
  } else {
    const submitTurnIntent = capturePortMethod(
      port,
      "submitTurnIntent",
      "agent node port"
    );
    const awaitSettledResult = capturePortMethod(
      port,
      "awaitSettledResult",
      "agent node port"
    );
    try {
      await submitTurnIntent(inputArtifact.payload, context);
    } catch (error) {
      if (isExecutionFailureError(error)) throw error;
      if (isNodeTurnInvocationUncertainError(error)) throw error;
      throw new NodeTurnInvocationUncertainError(
        "agent_submit",
        node.nodeId,
        context.idempotencyKey,
        error
      );
    }
    try {
      result = await awaitSettledResult(context);
    } catch (error) {
      if (isExecutionFailureError(error)) throw error;
      if (isNodeTurnInvocationUncertainError(error)) throw error;
      throw new NodeTurnInvocationUncertainError(
        "agent_await",
        node.nodeId,
        context.idempotencyKey,
        error
      );
    }
  }
  return captureCompletion(node, context.idempotencyKey, result);
}
