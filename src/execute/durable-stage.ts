// execute/durable-stage.ts — the durable stage executor: idempotency-keyed,
// cached-reusing, retry-bounded, dead-lettering execution of ONE compiled node
// for ONE run item, fenced through an evidence-only store port. The legacy
// entry accepts Pipeline's shard-token pair; executeBoundDurableStage passes
// through a host-owned opaque fence without lease lifecycle authority.
//
// PROMOTED from inbox-pipeline/src/durable-executor.ts (the idempotency-key
// digest; cached-success reuse with reused=true; the bounded attempt loop
// `previousAttempts + 1 .. maxAttempts`; dead-letter on exhaustion) MERGED
// with the fenced per-attempt semantics of src/worker/service.ts (the
// prepare→invoke→persist cycle; the stableFailure taxonomy — code strings,
// retryable flags, and item/shard scopes are promoted; item terminal =
// scope === "item" && (!retryable || attempt >= maxAttempts); terminal item
// replays stop at the same node, while shard-scoped failures finalize only at
// the shard boundary).
// CHANGES in the promotion:
//   - the idempotency key is digest({runId,itemId,stageId,version,fingerprint,
//     inputDigest}) where `fingerprint` derives from the CompiledPipelineNode
//     ALONE (bindingFingerprint + configurationFingerprint — the inbox keyed
//     on configurationFingerprint ?? "default" only; here the sealed binding
//     participates, so a binding change changes the key);
//   - contract validation moved OUT of stages INTO this executor via the
//     injected ContractValidator port: every input slot value is validated
//     before invoke, the output after — stages receive pre-validated input;
//   - only "at_least_once_idempotent" nodes are executable. "at_most_once"
//     is rejected before reservation/invocation because a process crash after
//     physical effect but before durable evidence cannot honestly distinguish
//     unapplied from indeterminate without a separate intent/reconciliation
//     protocol;
//   - immutable topology/contract/digest failures are IMMEDIATELY terminal
//     (never retried), promoted from the inbox
//     "immutable_configuration_rejected"/"immutable_stage_contract_rejected"
//     non-retryable arms.
//
// STANDALONE: relative imports only (no npm deps, no zod, no pg).

import { types as nodeTypes } from "node:util";

import { digest } from "../contracts/digest.js";
import type { ContractId } from "../contracts/artifact.js";
import type { ContractValidationIssue, ContractValidator } from "../catalog.js";
import {
  validateCompiledPipeline,
  validateCompiledPipelineNode,
  type CompiledPipelineNode
} from "../compile.js";
import type { StageContext } from "../node.js";
import {
  ShardLeaseLostError,
  WorkLeaseLostError,
  BoundEvidencePersistenceError,
  ExternalFenceRejectedError,
  EvidenceConflictError,
  outboxEventDigest,
  type BoundEvidenceOperation,
  type BoundPipelineEvidenceStore,
  type BoundPipelineExecutionIdentity,
  type BoundPipelineShard,
  type OutboxEvents,
  type PersistedStageResult,
  type PersistStageFailureInput,
  type PipelineStageEvidenceStore,
  type StagePreparation,
  type StageFailureScope
} from "../store.js";
import {
  isPipelineShardControlError,
  PipelineControlOutcomeError
} from "./control.js";
import {
  assertEvidenceDigest,
  assertEvidenceString,
  deepFrozenClone
} from "../internal/evidence.js";
import {
  captureCapabilityRecord,
  captureDenseArrayItems
} from "../internal/capability.js";
import { captureOutboxEvents } from "../internal/outbox.js";
import {
  ExecutionFailureError,
  classifyExecutionFailure,
  type ExecutionFailure
} from "./failure.js";

export {
  ExecutionFailureError,
  classifyExecutionFailure
} from "./failure.js";
export type { ExecutionFailure } from "./failure.js";

export type { StageFailureScope } from "../store.js";

/** Multi-slot composed inputs are prepared under this promoted marker contract. */
export const COMPOSITE_INPUT_CONTRACT: ContractId = "pipeline-node-input.v1";

/** The promoted default retry budget (inbox durable-pipeline maxAttempts ?? 2). */
export const DEFAULT_MAX_ATTEMPTS = 2;

// ── Failure taxonomy (promoted from worker/service.ts stableFailure) ──────

export interface StageFailure extends ExecutionFailure {
  scope: StageFailureScope;
}

function isInstanceOf<T>(
  value: unknown,
  constructor: abstract new (...args: any[]) => T
): value is T {
  try {
    if (
      value !== null
      && (typeof value === "object" || typeof value === "function")
      && nodeTypes.isProxy(value)
    ) {
      return false;
    }
    return value instanceof constructor;
  } catch {
    return false;
  }
}

/**
 * The typed, deliberate stage failure. Stages/invokers throw it to control
 * routing precisely; anything else is classified by {@link classifyStageFailure}.
 */
export class PipelineStageError extends ExecutionFailureError {
  readonly scope: StageFailureScope;

  constructor(code: string, retryable: boolean, cause?: unknown, scope: StageFailureScope = "shard") {
    super(code, retryable, cause);
    this.name = "PipelineStageError";
    this.scope = scope;
  }
}

/**
 * A contract-validation rejection from the injected ContractValidator —
 * ALWAYS immediately terminal (immutable contract failure), shard-scoped
 * (promoted from StageInputContractError/StageOutputContractError →
 * "immutable_stage_contract_rejected", retryable false, scope shard: the same
 * sealed configuration applies to every item, so a contract mismatch is a
 * broken topology, not bad luck).
 */
export class ContractViolationError extends Error {
  readonly code = "immutable_stage_contract_rejected";
  readonly contractId: ContractId;
  readonly issues: ContractValidationIssue[];

  constructor(where: string, contractId: ContractId, issues: ContractValidationIssue[]) {
    super(
      `${where}: value rejected by contract ${contractId}: ${issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; ") || "no issues reported"}`
    );
    this.name = "ContractViolationError";
    this.contractId = contractId;
    this.issues = issues;
  }
}

/**
 * Invocation completed, but Mission could not safely assemble the evidence
 * required for an atomic append. This is indeterminate, never a settleable
 * stage result; replay must reuse the same provider-attempt key.
 */
export class StageEvidenceAssemblyError extends Error {
  readonly code = "stage_evidence_assembly_failed";
  readonly operation:
    | "output_digest"
    | "success_outbox"
    | "failure_outbox"
    | "provider_receipt"
    | "gate_escalation"
    | "failure_metadata"
    | "timestamp";

  constructor(
    operation: StageEvidenceAssemblyError["operation"],
    cause: unknown
  ) {
    super(`stage evidence assembly failed during ${operation}`, { cause });
    this.name = "StageEvidenceAssemblyError";
    this.operation = operation;
  }
}

/** A concurrent winner did not prove this invocation's event batch durable. */
export class OutboxEvidenceNotCommittedError extends Error {
  readonly code = "outbox_evidence_not_committed";
  constructor() {
    super(
      "a concurrent stage-success winner appended no events for this invocation and did not prove the exact submitted outbox batch already durable"
    );
    this.name = "OutboxEvidenceNotCommittedError";
  }
}

/** A success winner under the same stage key produced different bytes. */
export class StageResultConflictError extends Error {
  readonly code = "stage_result_conflict";
  constructor(expectedOutputDigest: string, committedOutputDigest: string) {
    super(
      `stage success under the same idempotency key has conflicting output digests: invocation=${expectedOutputDigest} committed=${committedOutputDigest}`
    );
    this.name = "StageResultConflictError";
  }
}

/**
 * Promoted stableFailure: maps ANY thrown value to a stable
 * {code, retryable, scope} triple. Order matters — typed errors first, then
 * the promoted message heuristics, then the retryable item-scoped default.
 */
export function classifyStageFailure(error: unknown): StageFailure {
  try {
    if (
      error !== null
      && (typeof error === "object" || typeof error === "function")
      && nodeTypes.isProxy(error)
    ) {
      return { code: "untrusted_proxy_error", retryable: false, scope: "shard" };
    }
    if (isInstanceOf(error, OutboxEvidenceNotCommittedError)) {
      return { code: "outbox_evidence_not_committed", retryable: false, scope: "shard" };
    }
    if (isInstanceOf(error, StageResultConflictError)) {
      return { code: "stage_result_conflict", retryable: false, scope: "shard" };
    }
    if (isInstanceOf(error, StageEvidenceAssemblyError)) {
      return { code: "stage_evidence_assembly_failed", retryable: false, scope: "shard" };
    }
    if (isInstanceOf(error, EvidenceConflictError)) {
      return { code: "evidence_conflict", retryable: false, scope: "shard" };
    }
    if (isInstanceOf(error, PipelineStageError)) {
      const descriptors = Object.getOwnPropertyDescriptors(error);
      const code = descriptors.code;
      const retryable = descriptors.retryable;
      const scope = descriptors.scope;
      if (
        code !== undefined
        && "value" in code
        && typeof code.value === "string"
        && /^[a-z][a-z0-9._:-]{0,199}$/.test(code.value)
        && retryable !== undefined
        && "value" in retryable
        && typeof retryable.value === "boolean"
        && scope !== undefined
        && "value" in scope
        && (scope.value === "item" || scope.value === "shard")
      ) {
        return {
          code: code.value,
          retryable: retryable.value,
          scope: scope.value
        };
      }
      return {
        code: "invalid_pipeline_stage_error",
        retryable: false,
        scope: "shard"
      };
    }
    if (isInstanceOf(error, ShardLeaseLostError)) {
      return { code: "shard_lease_lost", retryable: true, scope: "shard" };
    }
    if (isInstanceOf(error, WorkLeaseLostError)) {
      return { code: "work_lease_lost", retryable: true, scope: "shard" };
    }
    if (isInstanceOf(error, ContractViolationError)) {
      return { code: "immutable_stage_contract_rejected", retryable: false, scope: "shard" };
    }
    if (
      isPipelineShardControlError(error)
      && isInstanceOf(error, PipelineControlOutcomeError)
    ) {
      // This signal belongs to runBoundShard. If it escapes after runOneShard
      // claimed a Pipeline-owned lease, that lease is settled conclusively
      // instead of being abandoned until expiry.
      return {
        code: "pipeline_control_outcome_unsupported",
        retryable: false,
        scope: "shard"
      };
    }
    const failure = classifyExecutionFailure(error);
    return {
      ...failure,
      scope: failure.retryable ? "item" : "shard"
    };
  } catch {
    return {
      code: "stage_failure_classification_failed",
      retryable: false,
      scope: "shard"
    };
  }
}

function errorMessage(error: unknown): string {
  try {
    return isInstanceOf(error, Error) ? `${error.name}: ${error.message}` : String(error);
  } catch (formatError) {
    throw new StageEvidenceAssemblyError("failure_metadata", formatError);
  }
}

// ── Idempotency key ───────────────────────────────────────────────────────

/**
 * The node's configuration fingerprint, derived from the CompiledPipelineNode
 * ALONE: the sealed binding fingerprint (sha256 | "none") + the descriptor's
 * configurationFingerprint (or the promoted "default" placeholder).
 */
export function stageFingerprint(node: CompiledPipelineNode): string {
  node = deepFrozenClone(
    validateCompiledPipelineNode(node, "stage fingerprint node"),
    "stage fingerprint node"
  );
  return stageFingerprintFromSnapshot(node);
}

function stageFingerprintFromSnapshot(node: CompiledPipelineNode): string {
  return digest({
    bindingFingerprint: node.bindingFingerprint,
    configurationFingerprint: node.configurationFingerprint ?? "default"
  });
}

/**
 * The B3 idempotency key: digest({runId,itemId,nodeId,stageId,version,
 * fingerprint,inputDigest[,executionIdentityDigest]}). `nodeId` prevents two
 * uses of the same stage in one DAG from colliding. Bound execution adds the
 * sealed host-action/run/shard/definition/item identity digest; Pipeline-owned
 * execution retains its durable run/shard store boundary. Identical replays
 * land on the same key, so successes are reused and budgets survive crashes.
 */
export function stageIdempotencyKey(input: {
  runId: string;
  itemId: string;
  node: CompiledPipelineNode;
  inputDigest: string;
  /** Bound execution identity; omitted on the Pipeline-owned legacy path. */
  executionIdentityDigest?: string;
}): string {
  const raw = captureCapabilityRecord(
    input,
    ["runId", "itemId", "node", "inputDigest", "executionIdentityDigest"],
    ["runId", "itemId", "node", "inputDigest"],
    "stage idempotency input"
  );
  input = Object.freeze({
    runId: assertEvidenceString(raw.runId, "stage idempotency input.runId"),
    itemId: assertEvidenceString(raw.itemId, "stage idempotency input.itemId"),
    node: deepFrozenClone(
      validateCompiledPipelineNode(raw.node, "stage idempotency input.node"),
      "stage idempotency input.node"
    ),
    inputDigest: assertEvidenceDigest(raw.inputDigest, "stage idempotency input.inputDigest"),
    ...(raw.executionIdentityDigest === undefined
      ? {}
      : {
          executionIdentityDigest: assertEvidenceDigest(
            raw.executionIdentityDigest,
            "stage idempotency input.executionIdentityDigest"
          )
        })
  });
  const payload: Record<string, unknown> = {
    runId: input.runId,
    itemId: input.itemId,
    nodeId: input.node.nodeId,
    stageId: input.node.stage.id,
    version: input.node.stage.version,
    fingerprint: stageFingerprintFromSnapshot(input.node),
    inputDigest: input.inputDigest
  };
  if (input.executionIdentityDigest !== undefined) {
    payload.executionIdentityDigest = input.executionIdentityDigest;
  }
  return digest(payload);
}

// ── The durable execution of one node for one item ────────────────────────

/** One resolved input slot: the compiled slot + the actual artifact value. */
export interface ResolvedSlotValue {
  slot: string;
  contract: ContractId;
  value: unknown;
}

/** Exact failed-attempt context for transactional-outbox projection. */
export interface StageFailureOutboxContext {
  runId: string;
  itemId: string;
  node: CompiledPipelineNode;
  attempt: number;
  idempotencyKey: string;
  errorCode: string;
  retryable: boolean;
  scope: StageFailureScope;
  terminal: boolean;
}

/**
 * Compose the invocation input from resolved slots — promoted verbatim from
 * worker/service.ts: ONE slot passes its bare value; several compose an
 * object keyed by slot name (contract {@link COMPOSITE_INPUT_CONTRACT}).
 */
export function composeStageInput(slots: readonly ResolvedSlotValue[]): { input: unknown; inputContract: ContractId } {
  if (slots.length === 0) throw new Error("composeStageInput: a node must resolve at least one input slot");
  if (slots.length === 1) return { input: slots[0].value, inputContract: slots[0].contract };
  return {
    input: Object.fromEntries(slots.map(({ slot, value }) => [slot, value])),
    inputContract: COMPOSITE_INPUT_CONTRACT
  };
}

export interface DurableStageInput {
  /** Evidence-only port; lease lifecycle authority is deliberately absent. */
  store: PipelineStageEvidenceStore;
  /** The injected payload-validation port (usually catalog.contracts). */
  contracts: ContractValidator;
  /** Fencing pair from the shard claim. */
  shardId: string;
  leaseToken: string;
  runId: string;
  itemId: string;
  node: CompiledPipelineNode;
  /** The node's resolved input slot values (validated per-slot before invoke). */
  slots: readonly ResolvedSlotValue[];
  /**
   * The actual execution of one attempt (the runner dispatches on node.kind:
   * a CodeStage.run for "code", the NodeInvoker port for model/agent/gate).
   * Receives the composed, contract-validated input.
   */
  invoke: (input: unknown, ctx: StageContext) => Promise<unknown>;
  /** Per-node retry budget; default {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /**
   * Host hook: outbox events appended ATOMICALLY with this exact fresh attempt.
   * The output remains the first argument for compatibility with existing
   * one-argument host callbacks; attempt context is additive.
   */
  outboxEvents?: (output: unknown, context: {
    runId: string;
    attempt: number;
    idempotencyKey: string;
  }) => OutboxEvents;
  /**
   * Host hook: outbox events appended ATOMICALLY with this exact failed
   * attempt. This is deliberately distinct from the success hook: provider
   * usage can be billable even when a response or agent result is unusable.
   */
  failureOutboxEvents?: (context: StageFailureOutboxContext) => OutboxEvents;
  /**
   * Digest-sealed externally bound action identity. It namespaces the stable
   * stage idempotency key without changing legacy Pipeline-owned keys.
   */
  executionIdentityDigest?: string;
  signal?: AbortSignal;
  now?: () => Date;
}

export type DurableStageResult =
  | {
      status: "succeeded";
      output: unknown;
      outputDigest: string;
      /** true ⇔ a previously persisted success was reused (nothing executed). */
      reused: boolean;
      idempotencyKey: string;
      attempts: number;
    }
  | {
      /** The item is terminalized at this node (dead-lettered now or by a previous fenced attempt). */
      status: "terminal";
      errorCode: string;
      idempotencyKey: string;
    };

/**
 * Durably execute ONE compiled node for ONE item. Item-scoped outcomes are
 * RETURNED (success or terminal — per-item failure isolation is the caller's
 * job); shard-scoped failures (lease lost, immutable configuration/contract
 * rejections, deliberate shard-scope PipelineStageErrors) are THROWN after
 * their attempt evidence is persisted, so the runner can fail the whole shard.
 *
 * Behavior, in order:
 * 1. validate every slot value via the ContractValidator (violation ⇒ terminal
 *    contract failure, thrown shard-scoped — nothing invoked);
 * 2. compose the input (promoted single-slot/composite rule), digest it,
 *    derive the idempotency key;
 * 3. prepareStageExecution: cached ⇒ validate + return reused:true; terminal ⇒
 *    return the terminal arm (replays stop at the same node, dead-letter
 *    exactly once); reserved ⇒ run attempt `prepared.attempt`;
 * 4. attempts exhausted already (crash replay past the budget) ⇒ dead-letter
 *    (idempotent) + terminal;
 * 5. invoke; validate the output contract; persistStageSuccess with the
 *    caller's outbox events (atomic);
 * 6. on failure: classify; item terminal = item scope AND
 *    (!retryable || attempt >= maxAttempts), so at_most_once item failures
 *    terminalize on their first attempt. Persist the attempt (fenced), with
 *    every item terminal's dead letter riding atomically. Shard scope never
 *    terminalizes the item: rethrow for failShard, promoting a retryable shard
 *    failure to conclusive when its stage-attempt budget is exhausted.
 */
export async function executeDurableStage(input: DurableStageInput): Promise<DurableStageResult> {
  const raw = snapshotEvidenceResult(
    input,
    [
      "store",
      "contracts",
      "shardId",
      "leaseToken",
      "runId",
      "itemId",
      "node",
      "slots",
      "invoke"
    ],
    [
      "maxAttempts",
      "outboxEvents",
      "failureOutboxEvents",
      "executionIdentityDigest",
      "signal",
      "now"
    ],
    "executeDurableStage input"
  );
  const prepareStageExecution = captureCapabilityMethod(
    raw.store,
    "prepareStageExecution",
    "stage evidence store"
  );
  const persistStageSuccess = captureCapabilityMethod(
    raw.store,
    "persistStageSuccess",
    "stage evidence store"
  );
  const persistStageFailure = captureCapabilityMethod(
    raw.store,
    "persistStageFailure",
    "stage evidence store"
  );
  const recordDeadLetter = captureCapabilityMethod(
    raw.store,
    "recordDeadLetter",
    "stage evidence store"
  );
  const validate = captureCapabilityMethod(raw.contracts, "validate", "stage contract validator");
  const invoke = raw.invoke;
  if (typeof invoke !== "function") {
    throw new Error("executeDurableStage input.invoke must be a function");
  }
  const outboxEvents = raw.outboxEvents;
  if (outboxEvents !== undefined && typeof outboxEvents !== "function") {
    throw new Error("executeDurableStage input.outboxEvents must be a function");
  }
  const failureOutboxEvents = raw.failureOutboxEvents;
  if (
    failureOutboxEvents !== undefined
    && typeof failureOutboxEvents !== "function"
  ) {
    throw new Error("executeDurableStage input.failureOutboxEvents must be a function");
  }
  const nowCandidate = raw.now ?? (() => new Date());
  if (typeof nowCandidate !== "function") {
    throw new Error("executeDurableStage input.now must be a function");
  }
  input = Object.freeze({
    store: Object.freeze({
      prepareStageExecution: prepareStageExecution as PipelineStageEvidenceStore["prepareStageExecution"],
      persistStageSuccess: persistStageSuccess as PipelineStageEvidenceStore["persistStageSuccess"],
      persistStageFailure: persistStageFailure as PipelineStageEvidenceStore["persistStageFailure"],
      recordDeadLetter: recordDeadLetter as PipelineStageEvidenceStore["recordDeadLetter"]
    }),
    contracts: Object.freeze({
      // The durable executor needs validation only; catalog construction owns
      // the separate knows() admission gate.
      knows: (_contractId: ContractId) => true,
      validate: (contractId: ContractId, value: unknown) => validate(contractId, value)
    }),
    shardId: assertEvidenceString(raw.shardId, "executeDurableStage input.shardId"),
    leaseToken: assertEvidenceString(raw.leaseToken, "executeDurableStage input.leaseToken"),
    runId: assertEvidenceString(raw.runId, "executeDurableStage input.runId"),
    itemId: assertEvidenceString(raw.itemId, "executeDurableStage input.itemId"),
    node: deepFrozenClone(raw.node, "executeDurableStage input.node") as CompiledPipelineNode,
    slots: deepFrozenClone(raw.slots, "executeDurableStage input.slots") as readonly ResolvedSlotValue[],
    invoke: (value: unknown, context: StageContext) => invoke(value, context),
    ...(raw.maxAttempts === undefined ? {} : { maxAttempts: raw.maxAttempts as number }),
    ...(outboxEvents === undefined
      ? {}
      : { outboxEvents: outboxEvents as DurableStageInput["outboxEvents"] }),
    ...(failureOutboxEvents === undefined
      ? {}
      : { failureOutboxEvents: failureOutboxEvents as DurableStageInput["failureOutboxEvents"] }),
    ...(raw.executionIdentityDigest === undefined
      ? {}
      : { executionIdentityDigest: assertEvidenceDigest(
          raw.executionIdentityDigest,
          "executeDurableStage input.executionIdentityDigest"
        ) }),
    ...(raw.signal === undefined ? {} : { signal: raw.signal as AbortSignal }),
    now: nowCandidate as () => Date
  }) as DurableStageInput;
  const { store, contracts, node } = input;
  const now = input.now!;

  if (node.deliverySemantics === "at_most_once") {
    throw new PipelineStageError(
      "at_most_once_execution_unsupported",
      false,
      new Error(
        `node ${node.nodeId} declares at_most_once, which v0.2 rejects before invocation: crash-safe execution requires durable intent plus indeterminate-effect reconciliation`
      ),
      "shard"
    );
  }

  // 1. Per-slot input validation — the executor validates, stages receive
  //    pre-validated input (B2 contract).
  const validatedSlots: ResolvedSlotValue[] = input.slots.map((slot) => {
    const result = contracts.validate(slot.contract, slot.value);
    if (!result.ok) {
      throw new ContractViolationError(
        `stage ${node.stage.id}@${node.stage.version} input slot ${slot.slot}`,
        slot.contract,
        result.issues
      );
    }
    return { slot: slot.slot, contract: slot.contract, value: result.value };
  });

  // 2. Compose + key.
  const { input: composedInputRaw, inputContract } = composeStageInput(validatedSlots);
  const composedInput = deepFrozenClone(
    composedInputRaw,
    `stage input for node ${node.nodeId}`
  );
  const inputDigest = digest(composedInput);
  const idempotencyKey = stageIdempotencyKey({
    runId: input.runId,
    itemId: input.itemId,
    node,
    inputDigest,
    ...(input.executionIdentityDigest === undefined
      ? {}
      : { executionIdentityDigest: input.executionIdentityDigest })
  });

  const configuredMax = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(configuredMax) || configuredMax < 1 || configuredMax > 10) {
    throw new Error(`executeDurableStage: maxAttempts must be an integer from 1 through 10 (got ${String(configuredMax)})`);
  }
  const maxAttempts = configuredMax;

  while (true) {
    // 3. Fenced reservation + cached-result lookup.
    const prepared = await callBoundEvidence(
      "prepare",
      () => store.prepareStageExecution({
      shardId: input.shardId,
      leaseToken: input.leaseToken,
      runId: input.runId,
      itemId: input.itemId,
      nodeId: node.nodeId,
      stage: { id: node.stage.id, version: node.stage.version },
      idempotencyKey,
      inputContract,
      input: composedInput,
      inputDigest
      }),
      validateStagePreparationResult
    );
    if (prepared.disposition === "cached") {
      const revalidated = contracts.validate(node.outputContract, prepared.output);
      if (!revalidated.ok) {
        throw new ContractViolationError(
          `stage ${node.stage.id}@${node.stage.version} cached output (node ${node.nodeId})`,
          node.outputContract,
          revalidated.issues
        );
      }
      const cachedOutput = assembleStageEvidence(
        "output_digest",
        () => deepFrozenClone(
          revalidated.value,
          `cached output for node ${node.nodeId}`
        )
      );
      const cachedOutputDigest = digest(cachedOutput);
      if (cachedOutputDigest !== prepared.outputDigest) {
        throw new StageResultConflictError(
          cachedOutputDigest,
          prepared.outputDigest
        );
      }
      return {
        status: "succeeded",
        output: cachedOutput,
        outputDigest: prepared.outputDigest,
        reused: true,
        idempotencyKey,
        attempts: 0
      };
    }
    if (prepared.disposition === "terminal") {
      if (prepared.scope === "shard") {
        throw new PipelineStageError(
          prepared.errorCode,
          false,
          undefined,
          "shard"
        );
      }
      // A previous fenced attempt already terminalized this item here.
      return { status: "terminal", errorCode: prepared.errorCode, idempotencyKey };
    }
    const attempt = prepared.attempt;

    // 4. Budget already exhausted (a crash landed between the last failed
    //    attempt and its terminalization): dead-letter idempotently, stop.
    if (attempt > maxAttempts) {
      if (prepared.previousFailure?.scope === "shard") {
        throw new PipelineStageError(
          prepared.previousFailure.errorCode,
          false,
          undefined,
          "shard"
        );
      }
      if (prepared.previousFailure?.scope !== "item") {
        throw new PipelineStageError(
          "immutable_configuration_rejected",
          false,
          new Error(
            "retry budget was exhausted without persisted failure scope"
          ),
          "shard"
        );
      }
      await callBoundEvidence(
        "record_dead_letter",
        () => store.recordDeadLetter({
          shardId: input.shardId,
          leaseToken: input.leaseToken,
          runId: input.runId,
          itemId: input.itemId,
          nodeId: node.nodeId,
          stage: { id: node.stage.id, version: node.stage.version },
          idempotencyKey,
          input: composedInput,
          error: { code: "retry_budget_exhausted", message: `retry budget exhausted after ${attempt - 1} attempts` },
          attempts: attempt - 1,
          createdAt: now().toISOString()
        }),
        validateCreatedResult
      );
      return { status: "terminal", errorCode: "retry_budget_exhausted", idempotencyKey };
    }

    const startedAt = now().toISOString();
    const ctx: StageContext = {
      runId: input.runId,
      itemId: input.itemId,
      attempt,
      idempotencyKey,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    };

    let output: unknown;
    try {
      // 5. The attempt itself, then output-contract validation.
      const rawOutput = await input.invoke(composedInput, ctx);
      const validated = contracts.validate(node.outputContract, rawOutput);
      if (!validated.ok) {
        throw new ContractViolationError(
          `stage ${node.stage.id}@${node.stage.version} output (node ${node.nodeId})`,
          node.outputContract,
          validated.issues
        );
      }
      output = assembleStageEvidence(
        "output_digest",
        () => deepFrozenClone(
          validated.value,
          `stage output for node ${node.nodeId}`
        )
      );
    } catch (error) {
      // 6. Failure routing (promoted terminal rule + taxonomy).
      if (
        isInstanceOf(error, ShardLeaseLostError)
        || isInstanceOf(error, WorkLeaseLostError)
        || isPipelineShardControlError(error)
      ) {
        throw error; // no failed-attempt evidence may be appended for these signals
      }
      const failure = classifyStageFailure(error);
      const budgetExhausted = attempt >= maxAttempts;
      const scopeTerminal = !failure.retryable || budgetExhausted;
      const message = errorMessage(error);
      const finishedAt = assembleStageEvidence(
        "timestamp",
        () => now().toISOString()
      );
      const failureBase = {
        shardId: input.shardId,
        leaseToken: input.leaseToken,
        executionId: prepared.executionId,
        idempotencyKey,
        runId: input.runId,
        itemId: input.itemId,
        nodeId: node.nodeId,
        attempt,
        startedAt,
        finishedAt,
        errorCode: failure.code,
        errorMessage: message,
        retryable: failure.retryable
      };
      const failureOutboxEvents = assembleStageEvidence(
        "failure_outbox",
        () => input.failureOutboxEvents?.({
          runId: input.runId,
          itemId: input.itemId,
          node,
          attempt,
          idempotencyKey,
          errorCode: failure.code,
          retryable: failure.retryable,
          scope: failure.scope,
          terminal: scopeTerminal
        })
      );
      const failureOutboxBatch = assembleStageEvidence(
        "failure_outbox",
        () => snapshotOutboxBatch(failureOutboxEvents ?? [])
      );
      const persistFailure = (
        failureInput: PersistStageFailureInput
      ): Promise<void> => {
        const persist = (): Promise<void> => failureOutboxBatch.events.length === 0
          ? store.persistStageFailure(failureInput)
          : store.persistStageFailure(failureInput, failureOutboxBatch.events);
        return callBoundEvidence(
          "persist_failure",
          persist,
          validateVoidEvidenceResult
        ).then(() => {
          acknowledgeOutboxEvents(failureOutboxBatch.acknowledge);
        });
      };
      if (failure.scope === "item") {
        if (scopeTerminal) {
          await persistFailure({
            ...failureBase,
            scope: "item",
            terminal: true,
            deadLetter: {
              runId: input.runId,
              itemId: input.itemId,
              nodeId: node.nodeId,
              stage: { id: node.stage.id, version: node.stage.version },
              idempotencyKey,
              input: composedInput,
              error: { code: failure.code, message },
              attempts: attempt,
              createdAt: finishedAt
            }
          });
        } else {
          await persistFailure({
            ...failureBase,
            scope: "item",
            terminal: false
          });
        }
      } else {
        await persistFailure({
          ...failureBase,
          scope: "shard",
          terminal: scopeTerminal
        });
      }
      if (failure.scope === "shard") {
        if (failure.retryable && budgetExhausted) {
          throw new PipelineStageError(
            failure.code,
            false,
            error,
            "shard"
          );
        }
        throw isInstanceOf(error, Error) ? error : new PipelineStageError(failure.code, failure.retryable, error, "shard");
      }
      if (scopeTerminal) {
        return { status: "terminal", errorCode: failure.code, idempotencyKey };
      }
      continue; // retryable item-scoped failure with budget left → next attempt
    }

    const outputDigest = assembleStageEvidence(
      "output_digest",
      () => digest(output)
    );
    const successOutboxEvents = assembleStageEvidence(
      "success_outbox",
      () => input.outboxEvents === undefined
        ? []
        : input.outboxEvents(output, {
            runId: input.runId,
            attempt,
            idempotencyKey
          })
    );
    const successOutboxBatch = assembleStageEvidence(
      "success_outbox",
      () => snapshotOutboxBatch(successOutboxEvents)
    );
    const submittedOutboxEventDigests = successOutboxBatch.events.map(outboxEventDigest);
    const finishedAt = assembleStageEvidence(
      "timestamp",
      () => now().toISOString()
    );
    const persisted = await callBoundEvidence(
      "persist_success",
      () => store.persistStageSuccess({
        shardId: input.shardId,
        leaseToken: input.leaseToken,
        executionId: prepared.executionId,
        idempotencyKey,
        runId: input.runId,
        itemId: input.itemId,
        nodeId: node.nodeId,
        attempt,
        startedAt,
        finishedAt,
        outputContract: node.outputContract,
        output,
        outputDigest
      }, successOutboxBatch.events),
      validatePersistedStageResult
    );
    if (persisted.outputDigest !== outputDigest) {
      throw new StageResultConflictError(outputDigest, persisted.outputDigest);
    }
    if (persisted.created) {
      acknowledgeOutboxEvents(successOutboxBatch.acknowledge);
    } else if (submittedOutboxEventDigests.length > 0) {
      const committed = persisted.committedOutboxEventDigests;
      if (
        committed === undefined
        || committed.length !== submittedOutboxEventDigests.length
        || committed.some(
          (eventDigest, index) =>
            eventDigest !== submittedOutboxEventDigests[index]
        )
      ) {
        throw new OutboxEvidenceNotCommittedError();
      }
      acknowledgeOutboxEvents(successOutboxBatch.acknowledge);
    } else {
      // An empty retry-safe peek contains no evidence to lose.
      acknowledgeOutboxEvents(successOutboxBatch.acknowledge);
    }
    return {
      status: "succeeded",
      output: persisted.output,
      outputDigest: persisted.outputDigest,
      // created:false = a concurrent/previous writer won the append; their
      // output is authoritative and this call reused it.
      reused: !persisted.created,
      idempotencyKey,
      attempts: attempt
    };
  }
}

/**
 * The externally fenced form of {@link DurableStageInput}. `fence` is an
 * opaque host value: Mission Pipeline passes the exact value to every evidence
 * operation without inspecting or retaining it. The supplied store has no
 * lease lifecycle methods.
 */
export interface BoundDurableStageInput<TFence>
  extends Omit<DurableStageInput, "store" | "shardId" | "leaseToken"> {
  evidenceStore: BoundPipelineEvidenceStore<TFence>;
  fence: TFence;
  /** Exact immutable shard whose seal authorizes this item and compiled node. */
  shard: BoundPipelineShard;
  executionIdentity: BoundPipelineExecutionIdentity;
}

/**
 * Execute one durable stage under a host-owned fence.
 *
 * This is a thin binding adapter over the established durable executor, not a
 * second retry/idempotency implementation. The private legacy marker pair is
 * consumed by the adapter and never reaches the host evidence store.
 */
export async function executeBoundDurableStage<TFence>(
  input: BoundDurableStageInput<TFence>
): Promise<DurableStageResult> {
  const raw = snapshotEvidenceResult(
    input,
    [
      "evidenceStore",
      "fence",
      "shard",
      "executionIdentity",
      "contracts",
      "runId",
      "itemId",
      "node",
      "slots",
      "invoke"
    ],
    [
      "maxAttempts",
      "outboxEvents",
      "failureOutboxEvents",
      "signal",
      "now"
    ],
    "executeBoundDurableStage input"
  );
  const evidenceStore = raw.evidenceStore as BoundPipelineEvidenceStore<TFence>;
  const fence = raw.fence as TFence;
  const coordinates = validateBoundStageExecutionCoordinates(
    raw.executionIdentity,
    raw.shard,
    raw.runId,
    raw.itemId,
    raw.node,
    raw.slots
  );
  const { executionIdentity, runId, itemId, node, slots } = coordinates;
  const stageInput = Object.freeze({
    contracts: raw.contracts as ContractValidator,
    runId,
    itemId,
    node,
    slots,
    invoke: raw.invoke as DurableStageInput["invoke"],
    ...(raw.maxAttempts === undefined ? {} : { maxAttempts: raw.maxAttempts as number }),
    ...(raw.outboxEvents === undefined ? {} : { outboxEvents: raw.outboxEvents as DurableStageInput["outboxEvents"] }),
    ...(raw.failureOutboxEvents === undefined ? {} : { failureOutboxEvents: raw.failureOutboxEvents as DurableStageInput["failureOutboxEvents"] }),
    ...(raw.signal === undefined ? {} : { signal: raw.signal as AbortSignal }),
    ...(raw.now === undefined ? {} : { now: raw.now as () => Date })
  });
  const prepareStageExecution = captureCapabilityMethod(
    evidenceStore,
    "prepareStageExecution",
    "bound evidence store"
  );
  const persistStageSuccess = captureCapabilityMethod(
    evidenceStore,
    "persistStageSuccess",
    "bound evidence store"
  );
  const persistStageFailure = captureCapabilityMethod(
    evidenceStore,
    "persistStageFailure",
    "bound evidence store"
  );
  const recordDeadLetter = captureCapabilityMethod(
    evidenceStore,
    "recordDeadLetter",
    "bound evidence store"
  );
  const store: PipelineStageEvidenceStore = {
    prepareStageExecution: ({
      shardId: _shardId,
      leaseToken: _leaseToken,
      ...evidence
    }) => callBoundEvidence(
      "prepare",
      () => prepareStageExecution({
        ...evidence,
        fence,
        executionIdentity
      }),
      validateStagePreparationResult
    ),
    persistStageSuccess: (
      {
        shardId: _shardId,
        leaseToken: _leaseToken,
        ...evidence
      },
      outboxEvents
    ) => callBoundEvidence(
      "persist_success",
      () => persistStageSuccess(
        { ...evidence, fence, executionIdentity },
        outboxEvents
      ),
      validatePersistedStageResult
    ),
    persistStageFailure: (
      {
        shardId: _shardId,
        leaseToken: _leaseToken,
        ...evidence
      },
      outboxEvents
    ) => callBoundEvidence(
      "persist_failure",
      () => persistStageFailure(
        { ...evidence, fence, executionIdentity },
        outboxEvents
      ),
      validateVoidEvidenceResult
    ),
    recordDeadLetter: ({
      shardId: _shardId,
      leaseToken: _leaseToken,
      ...evidence
    }) => callBoundEvidence(
      "record_dead_letter",
      () => recordDeadLetter({
        ...evidence,
        fence,
        executionIdentity
      }),
      validateCreatedResult
    )
  };
  return executeDurableStage({
    ...stageInput,
    store,
    shardId: "__externally_bound__",
    leaseToken: "__externally_bound__",
    executionIdentityDigest: executionIdentity.identityDigest
  });
}

function captureCapabilityMethod(
  target: unknown,
  key: string,
  label: string
): (...args: any[]) => any {
  if (
    target === null
    || (typeof target !== "object" && typeof target !== "function")
    || nodeTypes.isProxy(target)
  ) {
    throw new Error(`${label} must be a non-Proxy capability object`);
  }
  let cursor: object | null = target as object;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new Error(`${label} prototype chain must not contain a Proxy`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new Error(`${label}.${key} must be a data-property function`);
      }
      const method = descriptor.value;
      return (...args: any[]) => method.apply(target, args);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new Error(`${label}.${key} must be a function`);
}

async function callBoundEvidence<T>(
  operation: BoundEvidenceOperation,
  invoke: () => Promise<unknown>,
  validate: (value: unknown) => T
): Promise<T> {
  try {
    return validate(await invoke());
  } catch (error) {
    if (
      isInstanceOf(error, ExternalFenceRejectedError)
      || isInstanceOf(error, BoundEvidencePersistenceError)
      || isInstanceOf(error, ShardLeaseLostError)
      || isInstanceOf(error, WorkLeaseLostError)
      || isPipelineShardControlError(error)
    ) {
      throw error;
    }
    throw new BoundEvidencePersistenceError(operation, error);
  }
}

function snapshotEvidenceResult(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error(`${label} has unexpected symbol keys`);
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => descriptors[key] === undefined)
    || (keys as string[]).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} has missing or unexpected keys`);
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function validateBoundStageExecutionIdentity(
  value: unknown,
  expectedRunId: string
): BoundPipelineExecutionIdentity {
  const identity = snapshotEvidenceResult(
    deepFrozenClone(value, "bound execution identity"),
    [
      "schemaVersion",
      "hostActionId",
      "runId",
      "shardId",
      "pipeline",
      "compiledDigest",
      "itemCount",
      "itemSetDigest",
      "identityDigest"
    ],
    [],
    "bound execution identity"
  );
  if (identity.schemaVersion !== "bound-pipeline-execution.v1") {
    throw new Error("bound execution identity schemaVersion is unsupported");
  }
  const pipeline = snapshotEvidenceResult(
    identity.pipeline,
    ["id", "version", "definitionDigest"],
    [],
    "bound execution identity.pipeline"
  );
  const hostActionId = assertEvidenceString(identity.hostActionId, "bound execution identity.hostActionId");
  const runId = assertEvidenceString(identity.runId, "bound execution identity.runId");
  const shardId = assertEvidenceString(identity.shardId, "bound execution identity.shardId");
  const pipelineId = assertEvidenceString(pipeline.id, "bound execution identity.pipeline.id");
  if (!Number.isInteger(pipeline.version) || (pipeline.version as number) < 1) {
    throw new Error("bound execution identity.pipeline.version must be a positive integer");
  }
  const definitionDigest = assertEvidenceDigest(
    pipeline.definitionDigest,
    "bound execution identity.pipeline.definitionDigest"
  );
  const compiledDigest = assertEvidenceDigest(identity.compiledDigest, "bound execution identity.compiledDigest");
  const itemSetDigest = assertEvidenceDigest(identity.itemSetDigest, "bound execution identity.itemSetDigest");
  const identityDigest = assertEvidenceDigest(identity.identityDigest, "bound execution identity.identityDigest");
  if (!Number.isInteger(identity.itemCount) || (identity.itemCount as number) < 1) {
    throw new Error("bound execution identity.itemCount must be a positive integer");
  }
  if (runId !== expectedRunId) {
    throw new Error("bound execution identity.runId does not match stage runId");
  }
  const payload = {
    schemaVersion: "bound-pipeline-execution.v1" as const,
    hostActionId,
    runId,
    shardId,
    pipeline: {
      id: pipelineId,
      version: pipeline.version as number,
      definitionDigest
    },
    compiledDigest,
    itemCount: identity.itemCount as number,
    itemSetDigest
  };
  if (digest(payload) !== identityDigest) {
    throw new Error("bound execution identity identityDigest does not match payload");
  }
  const canonical = deepFrozenClone(
    { ...payload, identityDigest },
    "bound execution identity"
  );
  if (
    value !== null
    && typeof value === "object"
    && !nodeTypes.isProxy(value)
    && Object.isFrozen(value)
    && Object.isFrozen((value as { pipeline?: unknown }).pipeline)
  ) {
    return value as BoundPipelineExecutionIdentity;
  }
  return canonical;
}

interface BoundStageExecutionCoordinates {
  readonly executionIdentity: BoundPipelineExecutionIdentity;
  readonly runId: string;
  readonly itemId: string;
  readonly node: CompiledPipelineNode;
  readonly slots: readonly ResolvedSlotValue[];
}

/**
 * Bind the exported one-stage adapter to the same immutable shard coordinates
 * that {@code runBoundShard} validates. A self-consistent identity seal alone
 * is insufficient: the selected item and node must belong to that exact
 * compiled shard before any evidence capability or callback can be reached.
 */
function validateBoundStageExecutionCoordinates(
  identityRaw: unknown,
  shardRaw: unknown,
  runIdRaw: unknown,
  itemIdRaw: unknown,
  nodeRaw: unknown,
  slotsRaw: unknown
): BoundStageExecutionCoordinates {
  const shardSnapshot = deepFrozenClone(shardRaw, "bound stage shard");
  const shard = snapshotEvidenceResult(
    shardSnapshot,
    ["runId", "shardId", "compiled", "items"],
    [],
    "bound stage shard"
  );
  const runId = assertEvidenceString(runIdRaw, "executeBoundDurableStage input.runId");
  const shardRunId = assertEvidenceString(shard.runId, "bound stage shard.runId");
  const shardId = assertEvidenceString(shard.shardId, "bound stage shard.shardId");
  if (runId !== shardRunId) {
    throw new Error("executeBoundDurableStage input.runId does not match the immutable shard");
  }
  const compiled = deepFrozenClone(
    validateCompiledPipeline(shard.compiled),
    "bound stage compiled pipeline"
  );
  const itemValues = captureDenseArrayItems(
    shard.items,
    "bound stage shard.items"
  );
  if (itemValues.length < 1) {
    throw new Error("bound stage shard.items must be non-empty");
  }
  const seenItemIds = new Set<string>();
  const seenOrdinals = new Set<number>();
  let previousOrdinal = 0;
  const items = itemValues.map((itemRaw, index) => {
    const item = snapshotEvidenceResult(
      itemRaw,
      ["itemId", "ordinal", "input", "inputDigest"],
      [],
      `bound stage shard.items[${index}]`
    );
    const itemId = assertEvidenceString(
      item.itemId,
      `bound stage shard.items[${index}].itemId`
    );
    if (seenItemIds.has(itemId)) {
      throw new Error("bound stage shard itemId values must be unique");
    }
    if (
      !Number.isInteger(item.ordinal)
      || (item.ordinal as number) < 1
      || seenOrdinals.has(item.ordinal as number)
      || (item.ordinal as number) <= previousOrdinal
    ) {
      throw new Error("bound stage shard ordinals must be positive, unique, and ascending");
    }
    const inputDigest = assertEvidenceDigest(
      item.inputDigest,
      `bound stage shard.items[${index}].inputDigest`
    );
    const input = deepFrozenClone(
      item.input,
      `bound stage shard.items[${index}].input`
    );
    if (digest(input) !== inputDigest) {
      throw new Error(`bound stage shard item ${itemId} inputDigest does not match input`);
    }
    seenItemIds.add(itemId);
    seenOrdinals.add(item.ordinal as number);
    previousOrdinal = item.ordinal as number;
    return Object.freeze({
      itemId,
      ordinal: item.ordinal as number,
      input,
      inputDigest
    });
  });

  const executionIdentity = validateBoundStageExecutionIdentity(identityRaw, runId);
  const expectedItemSetDigest = digest(items.map((item) => ({
    itemId: item.itemId,
    ordinal: item.ordinal,
    inputDigest: item.inputDigest
  })));
  if (
    executionIdentity.runId !== shardRunId
    || executionIdentity.shardId !== shardId
    || executionIdentity.pipeline.id !== compiled.pipeline.id
    || executionIdentity.pipeline.version !== compiled.pipeline.version
    || executionIdentity.pipeline.definitionDigest !== compiled.pipeline.digest
    || executionIdentity.compiledDigest !== compiled.compiledDigest
    || executionIdentity.itemCount !== items.length
    || executionIdentity.itemSetDigest !== expectedItemSetDigest
  ) {
    throw new Error("bound execution identity does not match the immutable stage shard");
  }

  const itemId = assertEvidenceString(itemIdRaw, "executeBoundDurableStage input.itemId");
  const selectedItem = items.find((item) => item.itemId === itemId);
  if (selectedItem === undefined) {
    throw new Error("executeBoundDurableStage input.itemId is not a member of the immutable shard");
  }
  const node = deepFrozenClone(
    validateCompiledPipelineNode(nodeRaw, "executeBoundDurableStage input.node"),
    "executeBoundDurableStage input.node"
  );
  const compiledNode = compiled.nodes.find((candidate) => candidate.nodeId === node.nodeId);
  if (compiledNode === undefined || digest(compiledNode) !== digest(node)) {
    throw new Error("executeBoundDurableStage input.node is not the exact compiled shard node");
  }

  const slotValues = captureDenseArrayItems(
    slotsRaw,
    "executeBoundDurableStage input.slots"
  );
  if (slotValues.length !== node.inputs.length) {
    throw new Error("executeBoundDurableStage input.slots do not match the compiled node inputs");
  }
  const slots = slotValues.map((slotRaw, index) => {
    const slot = snapshotEvidenceResult(
      slotRaw,
      ["slot", "contract", "value"],
      [],
      `executeBoundDurableStage input.slots[${index}]`
    );
    const expected = node.inputs[index]!;
    if (slot.slot !== expected.slot || slot.contract !== expected.contract) {
      throw new Error("executeBoundDurableStage input.slots do not match the compiled node inputs");
    }
    const value = deepFrozenClone(
      slot.value,
      `executeBoundDurableStage input.slots[${index}].value`
    );
    if (
      expected.source.kind === "pipeline_input"
      && digest(value) !== selectedItem.inputDigest
    ) {
      throw new Error("executeBoundDurableStage pipeline-input slot does not match the sealed item");
    }
    return Object.freeze({
      slot: expected.slot,
      contract: expected.contract,
      value
    });
  });
  return Object.freeze({
    executionIdentity,
    runId,
    itemId,
    node,
    slots: Object.freeze(slots)
  });
}

function validateStagePreparationResult(value: unknown): StagePreparation {
  const base = snapshotEvidenceResult(
    value,
    ["disposition"],
    ["output", "outputDigest", "errorCode", "scope", "executionId", "attempt", "previousFailure"],
    "bound prepare result"
  );
  if (base.disposition === "cached") {
    const cached = snapshotEvidenceResult(
      base,
      ["disposition", "output", "outputDigest"],
      [],
      "bound cached prepare result"
    );
    const outputDigest = assertEvidenceDigest(cached.outputDigest, "bound cached prepare result.outputDigest");
    const output = deepFrozenClone(cached.output, "bound cached prepare result.output");
    if (digest(output) !== outputDigest) {
      throw new Error("bound cached prepare result outputDigest does not match output");
    }
    return Object.freeze({ disposition: "cached", output, outputDigest });
  }
  if (base.disposition === "terminal") {
    const terminal = snapshotEvidenceResult(
      base,
      ["disposition", "errorCode", "scope"],
      [],
      "bound terminal prepare result"
    );
    const errorCode = assertEvidenceString(terminal.errorCode, "bound terminal prepare result.errorCode");
    if (terminal.scope !== "item" && terminal.scope !== "shard") {
      throw new Error('bound terminal prepare result.scope must be "item" or "shard"');
    }
    return Object.freeze({ disposition: "terminal", errorCode, scope: terminal.scope });
  }
  if (base.disposition === "reserved") {
    const reserved = snapshotEvidenceResult(
      base,
      ["disposition", "executionId", "attempt"],
      ["previousFailure"],
      "bound reserved prepare result"
    );
    const executionId = assertEvidenceString(reserved.executionId, "bound reserved prepare result.executionId");
    if (!Number.isInteger(reserved.attempt) || (reserved.attempt as number) < 1) {
      throw new Error("bound reserved prepare result.attempt must be a positive integer");
    }
    let previousFailure: { errorCode: string; scope: "item" | "shard" } | undefined;
    if (reserved.previousFailure !== undefined) {
      const previous = snapshotEvidenceResult(
        reserved.previousFailure,
        ["errorCode", "scope"],
        [],
        "bound reserved prepare result.previousFailure"
      );
      const errorCode = assertEvidenceString(previous.errorCode, "bound reserved prepare result.previousFailure.errorCode");
      if (previous.scope !== "item" && previous.scope !== "shard") {
        throw new Error('bound reserved prepare result.previousFailure.scope must be "item" or "shard"');
      }
      previousFailure = Object.freeze({ errorCode, scope: previous.scope });
    }
    return Object.freeze({
      disposition: "reserved",
      executionId,
      attempt: reserved.attempt as number,
      ...(previousFailure === undefined ? {} : { previousFailure })
    });
  }
  throw new Error("bound prepare result disposition is unsupported");
}

function validatePersistedStageResult(value: unknown): PersistedStageResult {
  const result = snapshotEvidenceResult(
    value,
    ["output", "outputDigest", "created"],
    ["committedOutboxEventDigests"],
    "bound persisted-success result"
  );
  const outputDigest = assertEvidenceDigest(result.outputDigest, "bound persisted-success result.outputDigest");
  if (typeof result.created !== "boolean") {
    throw new Error("bound persisted-success result.created must be a boolean");
  }
  const output = deepFrozenClone(result.output, "bound persisted-success result.output");
  if (digest(output) !== outputDigest) {
    throw new Error("bound persisted-success result outputDigest does not match output");
  }
  let committedOutboxEventDigests: readonly string[] | undefined;
  if (result.committedOutboxEventDigests !== undefined) {
    const committed = captureDenseArrayItems(
      result.committedOutboxEventDigests,
      "bound persisted-success result.committedOutboxEventDigests"
    );
    committedOutboxEventDigests = Object.freeze(
      committed.map((eventDigest, index) =>
        assertEvidenceDigest(
          eventDigest,
          `bound persisted-success result.committedOutboxEventDigests[${index}]`
        )
      )
    );
  }
  return Object.freeze({
    output,
    outputDigest,
    created: result.created,
    ...(committedOutboxEventDigests === undefined ? {} : { committedOutboxEventDigests })
  });
}

function validateCreatedResult(value: unknown): { created: boolean } {
  const result = snapshotEvidenceResult(
    value,
    ["created"],
    [],
    "bound created result"
  );
  if (typeof result.created !== "boolean") {
    throw new Error("bound created result.created must be a boolean");
  }
  return Object.freeze({ created: result.created });
}

function validateVoidEvidenceResult(value: unknown): void {
  if (value !== undefined) {
    throw new Error("bound failure append must resolve undefined");
  }
}

/** Acknowledge a retry-safe peek only after its atomic append succeeded. */
function acknowledgeOutboxEvents(acknowledge: (() => void) | undefined): void {
  // Acknowledgement mutates only an in-memory pending index. Durable evidence
  // already committed successfully, so a bookkeeping bug must not turn that
  // success into a false failed stage or trigger a replay.
  try {
    if (typeof acknowledge !== "function") return;
    acknowledge();
  } catch {
    // Deliberately ignored; the ledger remains a conservative pending peek.
  }
}

function assembleStageEvidence<T>(
  operation: StageEvidenceAssemblyError["operation"],
  assemble: () => T
): T {
  try {
    return assemble();
  } catch (error) {
    if (
      isInstanceOf(error, BoundEvidencePersistenceError)
      || isInstanceOf(error, StageEvidenceAssemblyError)
    ) {
      throw error;
    }
    throw new StageEvidenceAssemblyError(operation, error);
  }
}

function snapshotOutboxBatch(events: OutboxEvents): {
  readonly events: readonly import("../store.js").OutboxEventInput[];
  readonly acknowledge?: () => void;
} {
  const captured = captureOutboxEvents(events, "outbox events");
  const batch = captured.events.map((eventValue, index) => {
    const event = snapshotEvidenceResult(
      eventValue,
      ["eventType", "payload"],
      ["dedupeKey"],
      `outbox events[${index}]`
    );
    const eventType = assertEvidenceString(
      event.eventType,
      `outbox events[${index}].eventType`
    );
    const dedupeKey = event.dedupeKey === undefined
      ? undefined
      : assertEvidenceString(
          event.dedupeKey,
          `outbox events[${index}].dedupeKey`
        );
    return Object.freeze({
      eventType,
      payload: deepFrozenClone(event.payload, `outbox events[${index}].payload`),
      ...(dedupeKey === undefined ? {} : { dedupeKey })
    });
  });
  return Object.freeze({
    events: Object.freeze(batch),
    ...(captured.acknowledge === undefined
      ? {}
      : { acknowledge: captured.acknowledge })
  });
}
