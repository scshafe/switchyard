// agent/executor-port.ts — the AgentStepExecutor port + the kind:"agent"
// NodeInvoker arm (mission-restructure B6).
//
// The port is the seam the EAL implements (A5): mission-pipeline builds a
// frozen AgentStepRequest and hands it to an executor; the executor runs one
// agent turn and returns an AgentStepResult. mission-pipeline NEVER interprets
// the environment descriptor — it carries it. The EAL's adapter is the ONE
// place that asserts the requested descriptor is a subset of what the bound
// environment grants (the fail-closed descriptor⊆granted check lives THERE,
// per design critique finding 11 — never in this package: the machine-
// ignorance boundary).
//
// The invoker performs ONE attempt (the durable executor owns idempotency,
// retries, dead letters, and — after invoke — output-contract validation, so
// this arm returns the raw output exactly like the B4 model arm). Routing:
//   completed   → return output (durable executor validates it downstream)
//   failed      → item-scoped TERMINAL (the agent ran and produced junk)
//   timed_out   → item-scoped RETRYABLE (the durable executor owns the budget)
//   infra_error → item-scoped RETRYABLE (never usably reached a provider)
//
// STANDALONE: relative imports + node: only.

import type { CompiledPipelineNode } from "../compile.js";
import type { ContractValidator } from "../catalog.js";
import { PipelineStageError } from "../execute/durable-stage.js";
import type { NodeInvocation, NodeInvoker } from "../execute/shard-runner.js";
import type { OutboxEventInput } from "../store.js";
import { digest } from "../contracts/digest.js";
import { validateArtifactRef, type ArtifactRef } from "../contracts/artifact.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";
import {
  validateAgentStepRequest,
  validateAgentStepResult,
  AGENT_STEP_REQUEST_SCHEMA_VERSION,
  type AgentStepRequest,
  type AgentStepResult,
  type AgentStepBudget
} from "./step.js";

// ── The port ──────────────────────────────────────────────────────────────

/**
 * The EAL implements this (A5: an adapter over a TurnExecutor). One call runs
 * one agent turn. `signal` fires when the invoker's deadline elapses — an
 * executor SHOULD abort and return status "timed_out", but the invoker also
 * races the deadline itself so a non-cooperative executor still surfaces as
 * timed_out.
 */
export interface AgentStepExecutor {
  execute(request: AgentStepRequest, signal?: AbortSignal): Promise<AgentStepResult>;
}

// ── Per-stage agent specs (host-registered, closed) ───────────────────────

/**
 * The host-registered brief material for one agent stage. Agent nodes carry no
 * binding ref (kind:"agent" ⇒ bindingFingerprint "none"), so specs are keyed by
 * stage identity — a CLOSED catalog the host publishes (an unknown agent stage
 * is LOUD, never a silent default). `environment` is the descriptor the step
 * requires (an environment-descriptor.v1 value, carried not interpreted).
 */
export interface AgentStepSpec {
  stage: { id: string; version: number };
  instructions: string;
  environment: Record<string, unknown>;
  deadlineMs: number;
  budget?: AgentStepBudget;
  /** Contract the composed input is sealed under for the request's inputArtifacts.
   *  Defaults to the node's primary input slot contract; required when the node
   *  has no input slots and this spec still wants an input artifact. */
  inputContract?: string;
}

// ── Receipts → outbox bridge (agent flavor of the B4 model ledger) ────────

export const AGENT_USAGE_RECEIPT_EVENT_TYPE = "agent_usage_receipt";
export const AGENT_USAGE_RECEIPT_EVENT_SCHEMA_VERSION = "agent-usage-receipt-event.v1";

export interface AgentUsageReceiptRecord {
  runId: string;
  itemId: string;
  nodeId: string;
  stage: { id: string; version: number };
  attempt: number;
  idempotencyKey: string;
  /** The 0-based index of this receipt within the step's usage array. */
  receiptIndex: number;
  receipt: UsageReceipt;
}

export interface AgentReceiptLedger {
  readonly records: readonly AgentUsageReceiptRecord[];
  onReceipt(record: AgentUsageReceiptRecord): void;
  outboxEventsFor(context: {
    runId: string;
    node: CompiledPipelineNode;
    itemId: string;
    output: unknown;
    attempt: number;
  }): OutboxEventInput[];
}

/** The receipt→outbox bridge (identical shape to the B4 model ledger): receipts
 *  recorded during an attempt ride the SAME atomic append as the stage success;
 *  receipts whose attempt never reaches persistStageSuccess stay in `records`. */
export function createAgentReceiptLedger(): AgentReceiptLedger {
  const records: AgentUsageReceiptRecord[] = [];
  const pending = new Map<string, AgentUsageReceiptRecord[]>();
  const keyOf = (
    runId: string,
    itemId: string,
    nodeId: string,
    attempt: number
  ): string => JSON.stringify([runId, itemId, nodeId, attempt]);
  return {
    get records(): readonly AgentUsageReceiptRecord[] {
      return records.slice();
    },
    onReceipt(record: AgentUsageReceiptRecord): void {
      records.push(record);
      const key = keyOf(
        record.runId,
        record.itemId,
        record.nodeId,
        record.attempt
      );
      const queue = pending.get(key);
      if (queue) queue.push(record);
      else pending.set(key, [record]);
    },
    outboxEventsFor(context: {
      runId: string;
      node: CompiledPipelineNode;
      itemId: string;
      output: unknown;
      attempt: number;
    }): OutboxEventInput[] {
      const key = keyOf(
        context.runId,
        context.itemId,
        context.node.nodeId,
        context.attempt
      );
      const queue = pending.get(key) ?? [];
      pending.delete(key);
      return queue.map((record) => ({
        eventType: AGENT_USAGE_RECEIPT_EVENT_TYPE,
        payload: {
          schemaVersion: AGENT_USAGE_RECEIPT_EVENT_SCHEMA_VERSION,
          runId: record.runId,
          itemId: record.itemId,
          nodeId: record.nodeId,
          stage: record.stage,
          attempt: record.attempt,
          idempotencyKey: record.idempotencyKey,
          receiptIndex: record.receiptIndex,
          receipt: record.receipt
        },
        dedupeKey: `agent-receipt:${record.runId}:${record.itemId}:${record.nodeId}:${record.attempt}:${record.receiptIndex}`
      }));
    }
  };
}

// ── createAgentNodeInvoker ────────────────────────────────────────────────

export interface AgentNodeInvokerOptions {
  executor: AgentStepExecutor;
  /** The published agent-stage specs (closed catalog). */
  specs: readonly AgentStepSpec[];
  /** The catalog ContractValidator — every spec's environment io/output contract
   *  referenced by a node must be known (fail closed at construction is deferred
   *  to the durable executor's output validation; this port keeps a handle for
   *  parity with the model/gate arms). */
  catalogContracts: ContractValidator;
  onReceipt?: (record: AgentUsageReceiptRecord) => void;
  /** Non-agent node kinds delegate here (chain with the model/gate arms). */
  fallback?: NodeInvoker;
  /** Injectable clock + timer for deadline racing (tests). Defaults to real. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

function assertContractValidator(value: unknown): ContractValidator {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as ContractValidator).knows !== "function" ||
    typeof (value as ContractValidator).validate !== "function"
  ) {
    throw new Error(
      "createAgentNodeInvoker: catalogContracts must implement the ContractValidator port { knows(contractId), validate(contractId, value) }"
    );
  }
  return value as ContractValidator;
}

const AGENT_DEADLINE_SENTINEL = Symbol("agent-step-deadline");

function specKey(stage: { id: string; version: number }): string {
  return `${stage.id}@${stage.version}`;
}

/** Build the kind:"agent" NodeInvoker arm. */
export function createAgentNodeInvoker(options: AgentNodeInvokerOptions): NodeInvoker {
  if (options === null || typeof options !== "object") {
    throw new Error("createAgentNodeInvoker: options must be an object");
  }
  const executor = options.executor;
  if (executor === null || typeof executor !== "object" || typeof executor.execute !== "function") {
    throw new Error("createAgentNodeInvoker: executor must implement the AgentStepExecutor port { execute(request, signal) }");
  }
  assertContractValidator(options.catalogContracts);
  if (!Array.isArray(options.specs)) {
    throw new Error("createAgentNodeInvoker: specs must be an array of AgentStepSpecs");
  }
  const specsByStage = new Map<string, AgentStepSpec>();
  for (const spec of options.specs) {
    if (spec === null || typeof spec !== "object" || typeof spec.stage?.id !== "string" || typeof spec.stage?.version !== "number") {
      throw new Error("createAgentNodeInvoker: each spec needs a { stage: { id, version } }");
    }
    const key = specKey(spec.stage);
    if (specsByStage.has(key)) {
      throw new Error(`createAgentNodeInvoker: duplicate agent spec for stage ${key}`);
    }
    specsByStage.set(key, spec);
  }

  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number): { cancel: () => void } => {
      const t = setTimeout(fn, ms);
      if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
      return { cancel: () => clearTimeout(t) };
    });

  function buildRequest(invocation: NodeInvocation, spec: AgentStepSpec): AgentStepRequest {
    const { node } = invocation;
    // Seal the composed input into ONE content-addressed input artifact under
    // the node's primary input contract (or the spec override). Source nodes
    // with no input slots and no override carry zero input artifacts.
    const inputArtifacts: ArtifactRef[] = [];
    const inputContract = spec.inputContract ?? node.inputs[0]?.contract;
    if (inputContract !== undefined) {
      inputArtifacts.push(
        validateArtifactRef({ contractId: inputContract, digest: digest(invocation.input) })
      );
    }
    return validateAgentStepRequest({
      schemaVersion: AGENT_STEP_REQUEST_SCHEMA_VERSION,
      stage: { stageId: node.stage.id, version: node.stage.version },
      environment: spec.environment,
      brief: {
        instructions: spec.instructions,
        inputArtifacts,
        outputContract: node.outputContract
      },
      idempotencyKey: `${invocation.runId}:${invocation.itemId}:${node.nodeId}:${invocation.attempt}`,
      ...(spec.budget !== undefined ? { budget: spec.budget } : {}),
      deadlineMs: spec.deadlineMs
    });
  }

  return {
    async invoke(invocation: NodeInvocation): Promise<unknown> {
      const { node } = invocation;
      if (node.kind !== "agent") {
        if (options.fallback) return options.fallback.invoke(invocation);
        throw new PipelineStageError(
          "agent_invoker_wrong_kind",
          false,
          new Error(`createAgentNodeInvoker handles kind "agent" only; node ${node.nodeId} is kind "${node.kind}" and no fallback invoker is configured`),
          "shard"
        );
      }
      const spec = specsByStage.get(specKey(node.stage));
      if (!spec) {
        // Unknown agent stage — closed catalog, LOUD, shard-scoped (immutable
        // configuration: no spec applies to every item alike).
        throw new PipelineStageError(
          "agent_spec_unresolved",
          false,
          new Error(`no agent-step spec registered for stage ${specKey(node.stage)} (node ${node.nodeId})`),
          "shard"
        );
      }

      const request = buildRequest(invocation, spec);

      // Deadline race: the invoker owns the wall-clock deadline so a
      // non-cooperative executor still surfaces as timed_out (retryable).
      const controller = new AbortController();
      const combinedSignal = invocation.signal
        ? anySignal([invocation.signal, controller.signal])
        : controller.signal;
      let timer: { cancel: () => void } | undefined;
      const deadline = new Promise<typeof AGENT_DEADLINE_SENTINEL>((resolve) => {
        timer = setTimer(() => resolve(AGENT_DEADLINE_SENTINEL), request.deadlineMs);
      });

      let raw: AgentStepResult | typeof AGENT_DEADLINE_SENTINEL;
      try {
        raw = await Promise.race([executor.execute(request, combinedSignal), deadline]);
      } catch (error) {
        // The executor threw — never usably reached a provider ⇒ retryable.
        throw new PipelineStageError("agent_executor_threw", true, error, "item");
      } finally {
        timer?.cancel();
        controller.abort();
      }

      if (raw === AGENT_DEADLINE_SENTINEL) {
        throw new PipelineStageError(
          "agent_step_timed_out",
          true,
          new Error(`agent step for node ${node.nodeId} exceeded its ${request.deadlineMs}ms deadline`),
          "item"
        );
      }

      let result: AgentStepResult;
      try {
        result = validateAgentStepResult(raw);
      } catch (error) {
        // A malformed result envelope is the executor's fault, not the item's —
        // but it is not retryable (the same bad executor will repeat). Item-
        // scoped terminal so other items proceed.
        throw new PipelineStageError("agent_result_malformed", false, error, "item");
      }

      // Record every receipt (both completed and non-completed steps that
      // reached a provider carry them).
      result.usage.forEach((receipt, receiptIndex) => {
        options.onReceipt?.({
          runId: invocation.runId,
          itemId: invocation.itemId,
          nodeId: node.nodeId,
          stage: { id: node.stage.id, version: node.stage.version },
          attempt: invocation.attempt,
          idempotencyKey: request.idempotencyKey,
          receiptIndex,
          receipt
        });
      });

      switch (result.status) {
        case "completed":
          // The durable executor validates result.output against
          // node.outputContract downstream — return it raw (B4 parity).
          return result.output;
        case "timed_out":
          throw new PipelineStageError("agent_step_timed_out", true, failureCause(result), "item");
        case "infra_error":
          throw new PipelineStageError("agent_step_infra_error", true, failureCause(result), "item");
        case "failed":
        default:
          // The agent ran and produced an unusable result — item-scoped
          // TERMINAL (dead-letter this item; others continue).
          throw new PipelineStageError("agent_step_failed", false, failureCause(result), "item");
      }
    }
  };
}

function failureCause(result: AgentStepResult): Error {
  return result.failure
    ? new Error(`${result.failure.kind}: ${result.failure.detail}`)
    : new Error(`agent step ended with status "${result.status}" and no failure detail`);
}

/** Minimal AbortSignal.any polyfill (node 18 lacks it); aborts when any input
 *  aborts. STANDALONE — no dependency on the node version's built-in. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}
