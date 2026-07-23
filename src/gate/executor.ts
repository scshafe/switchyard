// gate/executor.ts — createGateNodeInvoker: the NodeInvoker arm for
// kind:"gate" compiled pipeline nodes. It resolves the node's decision binding
// ref (bindingFingerprint) to a published, digest-sealed CompiledGateFlow and
// runs the flow's steps to ONE of the two proven terminals:
//   - valid_decision   → the gate node succeeds with the decision arm;
//   - human_escalation → the gate node ALSO succeeds (escalation is a proven
//     terminal, not a failure) with the escalation arm, and an outbox event is
//     emitted (dedupe-keyed) so the HOST can project it into its own
//     human-review domain — projections stay host-side, the engine only emits
//     the evidence-bearing event.
//
// EXECUTION MODEL (one invocation = one full flow walk; the B3 durable
// executor owns idempotency/retries/dead letters AROUND the whole gate node):
//   - deterministic + validator steps run PURE HOST FUNCTIONS from a CLOSED,
//     injected registry keyed by implementation id@version — flow data can
//     NAME an implementation but can never SUPPLY code, and a flow referencing
//     an implementation outside the registry fails LOUD at construction;
//   - model steps run through the SAME ModelBindingResolver port as
//     kind:"model" nodes (verifyResolvedModelBinding — identical prompt
//     identity checks) and the SAME receipt floor: every completed call MUST
//     yield a valid usage-receipt.v1 (validateUsageReceipt; missing/malformed/
//     silent-zero ⇒ TERMINAL) reported through onReceipt with `gateStepId`
//     set, so the B4 receipt ledger persists gate-step receipts through the
//     same transactional outbox;
//   - every step yields { outcome, output }: the outcome must be one of the
//     step's declared outcome codes and the output must satisfy the step's
//     outputContract (the injected ContractValidator) — then the compiled
//     flow's UNIQUE transition for (step, outcome) routes execution;
//   - BUDGET ACCUMULATION: each model receipt is checked against its step
//     tier's per-attempt ceilings and accumulated into GateBudgetSpent, which
//     must stay inside the termination certificate's proven worst-case bounds
//     in every enforced dimension — an over-budget flow terminates the ITEM,
//     it never silently overspends.
//
// The gate node's OUTPUT (both terminals) is the {@link GateNodeResult}
// envelope, validated downstream against the gate node's outputContract by the
// durable executor. The module carries NO authorization-granting vocabulary: a
// field that lets a flow authorize its own externalization is not representable
// — the result disposition is a closed two-value enum and every shape here is
// strict-keyed.
//
// STANDALONE: relative imports only (no npm deps, no zod).

import { isPlainObject } from "../internal/guards.js";
import { validateUsageReceipt, type UsageReceipt } from "../contracts/usage-receipt.js";
import type { ContractId } from "../contracts/artifact.js";
import type { ContractValidator } from "../catalog.js";
import type { CompiledPipelineNode } from "../compile.js";
import type { PipelineNodeBindingRef } from "../definition.js";
import type { OutboxEventInput } from "../store.js";
import { COMPOSITE_INPUT_CONTRACT, PipelineStageError } from "../execute/durable-stage.js";
import type { NodeInvocation, NodeInvoker } from "../execute/shard-runner.js";
import {
  verifyResolvedModelBinding,
  type ModelBindingResolver,
  type ModelUsageReceiptRecord,
  type ResolvedModelBinding
} from "../model/invoker.js";
import type { GateStepKind } from "./contracts.js";
import {
  validateCompiledGateFlow,
  type CompiledGateFlow,
  type CompiledGateFlowStep
} from "./compiler.js";

// ── The closed deterministic/validator step registry ──────────────────────

/** What a deterministic/validator step function receives alongside its input. */
export interface GateStepRunContext {
  readonly runId: string;
  readonly itemId: string;
  readonly nodeId: string;
  readonly stepId: string;
  /** The gate NODE attempt (the durable executor's attempt number). */
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

/** Every gate step resolves to an outcome code + an output artifact. */
export interface GateStepResult {
  outcome: string;
  output: unknown;
}

/**
 * One entry of the CLOSED registry: pure host code, identified by the
 * implementation `{ id, version }` gate flows reference. The registry is
 * injected at construction — flow data can never supply code.
 */
export interface GateStepImplementation {
  readonly id: string;
  readonly version: number;
  run(input: unknown, context: GateStepRunContext): GateStepResult | Promise<GateStepResult>;
}

function implementationKey(id: string, version: number): string {
  return `${id} ${version}`;
}

// ── The gate node result (both terminals map onto the node outputContract) ─

export const GATE_NODE_RESULT_SCHEMA_VERSION = "gate-node-result.v1";

export interface GateExecutedStep {
  stepId: string;
  kind: GateStepKind;
  outcome: string;
}

/** The accumulated actuals of one flow walk (enforced against the certificate bounds). */
export interface GateBudgetSpent {
  pathSteps: number;
  modelCalls: number;
  chargedTokens: number;
  chargedCostMicroUsd: number;
  elapsedMs: number;
}

export interface GateNodeResult {
  schemaVersion: typeof GATE_NODE_RESULT_SCHEMA_VERSION;
  disposition: "valid_decision" | "human_escalation";
  flow: { id: string; version: number; compiledDigest: string };
  certificateDigest: string;
  /** The executed path, in order. */
  path: GateExecutedStep[];
  budgetSpent: GateBudgetSpent;
  /** Present exactly when disposition === "valid_decision". */
  decision?: { contract: ContractId; output: unknown };
  /** Present exactly when disposition === "human_escalation". */
  escalation?: { reasonCode: string; sourceStepId: string; outcomeCode: string };
}

// ── Escalation records + the outbox-riding ledger ─────────────────────────

export const GATE_HUMAN_ESCALATION_EVENT_TYPE = "gate_human_escalation";
export const GATE_HUMAN_ESCALATION_EVENT_SCHEMA_VERSION = "gate-human-escalation-event.v1";

/** One human escalation, attributed to its exact attempt. */
export interface GateHumanEscalationRecord {
  runId: string;
  itemId: string;
  nodeId: string;
  stage: { id: string; version: number };
  attempt: number;
  flow: { id: string; version: number; compiledDigest: string };
  certificateDigest: string;
  reasonCode: string;
  sourceStepId: string;
  outcomeCode: string;
  budgetSpent: GateBudgetSpent;
}

export interface GateEscalationLedger {
  /** Every escalation observed, in order. */
  readonly records: readonly GateHumanEscalationRecord[];
  /** Wire as createGateNodeInvoker's onEscalation. */
  onEscalation(record: GateHumanEscalationRecord): void;
  /**
   * Wire as (part of) ShardRunnerOptions.outboxEventsFor: drains this
   * (itemId, nodeId)'s pending escalations into dedupe-keyed outbox events
   * that ride ATOMICALLY with the gate node's persistStageSuccess append.
   * Compose with the model receipt ledger's hook when a pipeline carries both
   * node kinds: `(ctx) => [...receipts.outboxEventsFor(ctx), ...gates.outboxEventsFor(ctx)]`.
   */
  outboxEventsFor(context: { node: CompiledPipelineNode; itemId: string; output: unknown }): OutboxEventInput[];
}

/** The escalation→outbox bridge (the model receipt ledger's promoted shape). */
export function createGateEscalationLedger(): GateEscalationLedger {
  const records: GateHumanEscalationRecord[] = [];
  const pending = new Map<string, GateHumanEscalationRecord[]>();
  const keyOf = (itemId: string, nodeId: string): string => `${itemId} ${nodeId}`;
  return {
    get records(): readonly GateHumanEscalationRecord[] {
      return records.slice();
    },
    onEscalation(record: GateHumanEscalationRecord): void {
      records.push(record);
      const key = keyOf(record.itemId, record.nodeId);
      const queue = pending.get(key);
      if (queue) queue.push(record);
      else pending.set(key, [record]);
    },
    outboxEventsFor(context: { node: CompiledPipelineNode; itemId: string; output: unknown }): OutboxEventInput[] {
      const key = keyOf(context.itemId, context.node.nodeId);
      const queue = pending.get(key) ?? [];
      pending.delete(key);
      return queue.map((record) => ({
        eventType: GATE_HUMAN_ESCALATION_EVENT_TYPE,
        payload: {
          schemaVersion: GATE_HUMAN_ESCALATION_EVENT_SCHEMA_VERSION,
          runId: record.runId,
          itemId: record.itemId,
          nodeId: record.nodeId,
          stage: record.stage,
          attempt: record.attempt,
          flow: record.flow,
          certificateDigest: record.certificateDigest,
          reasonCode: record.reasonCode,
          sourceStepId: record.sourceStepId,
          outcomeCode: record.outcomeCode,
          budgetSpent: record.budgetSpent
        },
        dedupeKey: `gate-escalation:${record.runId}:${record.itemId}:${record.nodeId}:${record.attempt}`
      }));
    }
  };
}

// ── Binding-ref projection ────────────────────────────────────────────────

/**
 * Project a sealed compiled gate flow to the {@link PipelineNodeBindingRef} a
 * kind:"gate" definition node carries (`{ kind:"decision", … }` — the node
 * vocabulary keeps the promoted binding-kind name). The compiler stamps
 * `bindingDigest` (the COMPILED digest, certificate included) into the
 * compiled node as `bindingFingerprint`, which this executor resolves.
 */
export function gateFlowBindingRef(compiledRaw: unknown): PipelineNodeBindingRef {
  const compiled = validateCompiledGateFlow(compiledRaw);
  return {
    kind: "decision",
    bindingId: compiled.flow.id,
    version: compiled.flow.version,
    bindingDigest: compiled.compiledDigest
  };
}

// ── createGateNodeInvoker ─────────────────────────────────────────────────

export interface GateNodeInvokerOptions {
  /** The SAME model-execution port kind:"model" nodes use. */
  resolver: ModelBindingResolver;
  /** The published sealed compiled flows this invoker may execute (validated LOUDLY up front). */
  flows: readonly unknown[];
  /** The CLOSED deterministic/validator step registry (validated LOUDLY up front). */
  steps: readonly GateStepImplementation[];
  /**
   * The catalog's ContractValidator: every flow/step contract (and every model
   * step's recorded responseContract) must be KNOWN at construction, and step
   * outputs are validated against their outputContract at run time.
   */
  catalogContracts: ContractValidator;
  /** Fires for EVERY validated gate model-step receipt (gateStepId set). */
  onReceipt?: (record: ModelUsageReceiptRecord) => void;
  /** Fires for every human_escalation terminal (wire the escalation ledger here). */
  onEscalation?: (record: GateHumanEscalationRecord) => void;
  /** Non-gate node kinds delegate here (chain with createModelNodeInvoker); absent ⇒ LOUD. */
  fallback?: NodeInvoker;
  /** Millisecond clock for elapsed accounting (injectable for tests). */
  now?: () => number;
}

interface PreparedFlow {
  flow: CompiledGateFlow;
  stepsById: Map<string, CompiledGateFlowStep>;
  transitionByKey: Map<string, CompiledGateFlow["transitions"][number]>;
}

function transitionKey(stepId: string, outcomeCode: string): string {
  return `${stepId} ${outcomeCode}`;
}

function assertContractValidator(value: unknown): ContractValidator {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as ContractValidator).knows !== "function" ||
    typeof (value as ContractValidator).validate !== "function"
  ) {
    throw new Error(
      "createGateNodeInvoker: catalogContracts must implement the ContractValidator port { knows(contractId), validate(contractId, value) }"
    );
  }
  return value as ContractValidator;
}

/**
 * Build the kind:"gate" NodeInvoker arm. Construction FAILS CLOSED: flows are
 * seal-validated (certificates recomputed), every referenced contract must be
 * known, every deterministic/validator implementation must be present in the
 * closed registry, and duplicate flow digests / registry identities are LOUD.
 */
export function createGateNodeInvoker(options: GateNodeInvokerOptions): NodeInvoker {
  if (options === null || typeof options !== "object") {
    throw new Error("createGateNodeInvoker: options must be an object");
  }
  const resolver = options.resolver;
  if (resolver === null || typeof resolver !== "object" || typeof resolver.resolve !== "function") {
    throw new Error("createGateNodeInvoker: resolver must implement the ModelBindingResolver port { resolve(binding) }");
  }
  const contracts = assertContractValidator(options.catalogContracts);
  if (!Array.isArray(options.steps)) {
    throw new Error("createGateNodeInvoker: steps must be an array of GateStepImplementations (the closed registry)");
  }
  const registry = new Map<string, GateStepImplementation>();
  for (const implementation of options.steps) {
    if (
      implementation === null ||
      typeof implementation !== "object" ||
      typeof implementation.id !== "string" ||
      !Number.isInteger(implementation.version) ||
      implementation.version < 1 ||
      typeof implementation.run !== "function"
    ) {
      throw new Error(
        "createGateNodeInvoker: every registry entry must be { id: string, version: positive int, run: function }"
      );
    }
    const key = implementationKey(implementation.id, implementation.version);
    if (registry.has(key)) {
      throw new Error(`createGateNodeInvoker: duplicate step implementation ${implementation.id}@${implementation.version}`);
    }
    registry.set(key, implementation);
  }

  if (!Array.isArray(options.flows)) {
    throw new Error("createGateNodeInvoker: flows must be an array of sealed CompiledGateFlows");
  }
  const flowsByDigest = new Map<string, PreparedFlow>();
  for (const raw of options.flows) {
    const flow = validateCompiledGateFlow(raw);
    if (flowsByDigest.has(flow.compiledDigest)) {
      throw new Error(
        `createGateNodeInvoker: duplicate compiled gate flow digest ${flow.compiledDigest} (${flow.flow.id}@${flow.flow.version})`
      );
    }
    const flowIdentity = `${flow.flow.id}@${flow.flow.version}`;
    // Fail closed: every contract the flow can touch must be known NOW.
    const referenced = new Set<ContractId>([flow.inputContract, flow.decisionContract]);
    for (const step of flow.steps) {
      referenced.add(step.inputContract);
      referenced.add(step.outputContract);
      if (step.kind === "model") {
        referenced.add(step.binding.inferenceProfileRef.parameters.responseContract);
      }
    }
    const unknown = [...referenced].filter((contract) => !contracts.knows(contract));
    if (unknown.length > 0) {
      throw new Error(
        `createGateNodeInvoker: gate flow ${flowIdentity} references unknown contract(s): ${unknown.join(", ")} — the catalog ContractValidator must know every referenced contract (fail closed)`
      );
    }
    // Fail closed: the registry is CLOSED — every deterministic/validator step
    // implementation must already be registered host code.
    for (const step of flow.steps) {
      if (step.kind === "model") continue;
      const key = implementationKey(step.implementation.id, step.implementation.version);
      if (!registry.has(key)) {
        throw new Error(
          `createGateNodeInvoker: gate flow ${flowIdentity} step ${step.stepId} names implementation ${step.implementation.id}@${step.implementation.version}, which is not in the injected step registry (closed registry — flow data cannot supply code)`
        );
      }
    }
    flowsByDigest.set(flow.compiledDigest, {
      flow,
      stepsById: new Map(flow.steps.map((step) => [step.stepId, step])),
      transitionByKey: new Map(flow.transitions.map((transition) => [transitionKey(transition.sourceStepId, transition.outcomeCode), transition]))
    });
  }

  const resolvedCache = new Map<string, ResolvedModelBinding>();
  const now = options.now ?? (() => Date.now());

  function validateStepResult(step: CompiledGateFlowStep, resultRaw: unknown, nodeId: string): GateStepResult {
    // Model-step misbehavior is the item's bad luck (retry within the node
    // budget); a trusted deterministic/validator function breaking its
    // contract poisons every item identically — shard-scoped, non-retryable.
    const modelStep = step.kind === "model";
    const retryable = modelStep;
    const scope = modelStep ? "item" : "shard";
    if (!isPlainObject(resultRaw) || typeof resultRaw.outcome !== "string" || !("output" in resultRaw)) {
      throw new PipelineStageError(
        "gate_step_result_malformed",
        retryable,
        new Error(
          `gate step ${step.stepId} (${step.kind}) in node ${nodeId} must yield { outcome, output } (got ${typeof resultRaw})`
        ),
        scope
      );
    }
    const outcome = resultRaw.outcome;
    if (!step.outcomes.some((candidate) => candidate.code === outcome)) {
      throw new PipelineStageError(
        "gate_step_unknown_outcome",
        retryable,
        new Error(
          `gate step ${step.stepId} yielded undeclared outcome ${JSON.stringify(outcome)} (declared: ${step.outcomes.map((candidate) => candidate.code).join(", ")})`
        ),
        scope
      );
    }
    const validated = contracts.validate(step.outputContract, resultRaw.output);
    if (!validated.ok) {
      throw new PipelineStageError(
        "gate_step_output_rejected",
        retryable,
        new Error(
          `gate step ${step.stepId} output rejected by contract ${step.outputContract}: ${validated.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; ") || "no issues reported"}`
        ),
        scope
      );
    }
    return { outcome, output: validated.value };
  }

  async function runModelStep(
    step: CompiledGateFlowStep & { kind: "model" },
    input: unknown,
    invocation: NodeInvocation,
    spent: GateBudgetSpent,
    bounds: { maximumModelCalls: number; maximumTokens: number; maximumCostMicroUsd: number }
  ): Promise<unknown> {
    const binding = step.binding;
    let resolved = resolvedCache.get(binding.bindingDigest);
    if (!resolved) {
      resolved = verifyResolvedModelBinding(await resolver.resolve(binding), binding);
      resolvedCache.set(binding.bindingDigest, resolved);
    }
    const result = await resolved.invoke(
      {
        runId: invocation.runId,
        itemId: invocation.itemId,
        nodeId: invocation.node.nodeId,
        stage: { id: invocation.node.stage.id, version: invocation.node.stage.version },
        attempt: invocation.attempt,
        input,
        binding
      },
      invocation.signal
    );

    // ── THE RECEIPT FLOOR (identical to the kind:"model" arm) ─────────────
    if (!isPlainObject(result) || !("output" in result)) {
      throw new PipelineStageError(
        "model_result_malformed",
        false,
        new Error(`resolver for binding ${binding.bindingId}@${binding.version} returned no { output, usage } result (gate step ${step.stepId})`),
        "item"
      );
    }
    if (!("usage" in result) || result.usage === undefined || result.usage === null) {
      throw new PipelineStageError(
        "model_receipt_missing",
        false,
        new Error(
          `gate model step ${step.stepId} (binding ${binding.bindingId}@${binding.version}) completed WITHOUT a usage receipt — every attempt must record one`
        ),
        "item"
      );
    }
    let receipt: UsageReceipt;
    try {
      receipt = validateUsageReceipt(result.usage);
    } catch (error) {
      throw new PipelineStageError("model_receipt_rejected", false, error, "item");
    }
    options.onReceipt?.({
      runId: invocation.runId,
      itemId: invocation.itemId,
      nodeId: invocation.node.nodeId,
      stage: { id: invocation.node.stage.id, version: invocation.node.stage.version },
      attempt: invocation.attempt,
      bindingDigest: binding.bindingDigest,
      receipt,
      gateStepId: step.stepId
    });

    // ── BUDGET: per-attempt tier ceilings, then accumulated bounds ────────
    if (receipt.chargedTokens > step.budget.maxTokensPerAttempt) {
      throw new PipelineStageError(
        "gate_budget_exceeded",
        false,
        new Error(
          `gate step ${step.stepId} charged ${receipt.chargedTokens} tokens, above its tier ceiling ${step.budget.maxTokensPerAttempt}`
        ),
        "item"
      );
    }
    if (receipt.chargedCostMicroUsd > step.budget.maxCostMicroUsdPerAttempt) {
      throw new PipelineStageError(
        "gate_budget_exceeded",
        false,
        new Error(
          `gate step ${step.stepId} charged ${receipt.chargedCostMicroUsd} micro-USD, above its tier ceiling ${step.budget.maxCostMicroUsdPerAttempt}`
        ),
        "item"
      );
    }
    spent.modelCalls += 1;
    spent.chargedTokens += receipt.chargedTokens;
    spent.chargedCostMicroUsd += receipt.chargedCostMicroUsd;
    if (spent.modelCalls > bounds.maximumModelCalls) {
      throw new PipelineStageError(
        "gate_budget_exceeded",
        false,
        new Error(`gate flow spent ${spent.modelCalls} model calls, above the certified bound ${bounds.maximumModelCalls}`),
        "item"
      );
    }
    if (spent.chargedTokens > bounds.maximumTokens) {
      throw new PipelineStageError(
        "gate_budget_exceeded",
        false,
        new Error(`gate flow spent ${spent.chargedTokens} tokens, above the certified bound ${bounds.maximumTokens}`),
        "item"
      );
    }
    if (spent.chargedCostMicroUsd > bounds.maximumCostMicroUsd) {
      throw new PipelineStageError(
        "gate_budget_exceeded",
        false,
        new Error(
          `gate flow spent ${spent.chargedCostMicroUsd} micro-USD, above the certified bound ${bounds.maximumCostMicroUsd}`
        ),
        "item"
      );
    }
    return result.output;
  }

  return {
    async invoke(invocation: NodeInvocation): Promise<unknown> {
      const { node } = invocation;
      if (node.kind !== "gate") {
        if (options.fallback) return options.fallback.invoke(invocation);
        throw new PipelineStageError(
          "gate_invoker_wrong_kind",
          false,
          new Error(
            `createGateNodeInvoker handles kind "gate" only; node ${node.nodeId} is kind "${node.kind}" and no fallback invoker is configured`
          ),
          "shard"
        );
      }
      const prepared = flowsByDigest.get(node.bindingFingerprint);
      if (!prepared) {
        // Immutable configuration, LOUD (the digest-must-match rule).
        throw new PipelineStageError(
          "gate_flow_unresolved",
          false,
          new Error(`no published compiled gate flow matches bindingFingerprint ${node.bindingFingerprint} (node ${node.nodeId})`),
          "shard"
        );
      }
      const { flow, stepsById, transitionByKey } = prepared;

      // The composed node input IS the flow's entry input: single-slot nodes
      // must feed the flow's input contract; multi-slot composition would
      // arrive under the composite marker contract — sealed-config mismatch.
      const composedContract = node.inputs.length === 1 ? node.inputs[0].contract : COMPOSITE_INPUT_CONTRACT;
      if (composedContract !== flow.inputContract) {
        throw new PipelineStageError(
          "gate_input_contract_mismatch",
          false,
          new Error(
            `gate node ${node.nodeId} composes input contract ${composedContract}, but flow ${flow.flow.id}@${flow.flow.version} expects ${flow.inputContract}`
          ),
          "shard"
        );
      }

      const bounds = flow.terminationCertificate.proof.bounds;
      const spent: GateBudgetSpent = { pathSteps: 0, modelCalls: 0, chargedTokens: 0, chargedCostMicroUsd: 0, elapsedMs: 0 };
      const path: GateExecutedStep[] = [];
      const startedAtMs = now();

      let currentStepId = flow.entryStepId;
      let currentInput: unknown = invocation.input;
      while (true) {
        spent.pathSteps += 1;
        if (spent.pathSteps > bounds.maximumPathSteps) {
          // The certificate proved this impossible — reaching it means the
          // executor no longer matches the proof. LOUD, shard-scoped.
          throw new PipelineStageError(
            "gate_flow_diverged",
            false,
            new Error(
              `gate flow ${flow.flow.id}@${flow.flow.version} walked ${spent.pathSteps} steps, above the certified maximumPathSteps ${bounds.maximumPathSteps}`
            ),
            "shard"
          );
        }
        const step = stepsById.get(currentStepId);
        if (!step) {
          throw new PipelineStageError(
            "gate_flow_diverged",
            false,
            new Error(`gate flow ${flow.flow.id}@${flow.flow.version} routed to unknown step ${currentStepId}`),
            "shard"
          );
        }

        let stepOutputRaw: unknown;
        if (step.kind === "model") {
          stepOutputRaw = await runModelStep(step, currentInput, invocation, spent, bounds);
        } else {
          const implementation = registry.get(implementationKey(step.implementation.id, step.implementation.version));
          if (!implementation) {
            // Construction proved coverage; a miss here means the flow set changed under us.
            throw new PipelineStageError(
              "gate_step_implementation_unknown",
              false,
              new Error(
                `gate step ${step.stepId} implementation ${step.implementation.id}@${step.implementation.version} is not in the closed registry`
              ),
              "shard"
            );
          }
          const context: GateStepRunContext = {
            runId: invocation.runId,
            itemId: invocation.itemId,
            nodeId: node.nodeId,
            stepId: step.stepId,
            attempt: invocation.attempt,
            ...(invocation.signal === undefined ? {} : { signal: invocation.signal })
          };
          stepOutputRaw = await implementation.run(currentInput, context);
        }

        const { outcome, output } = validateStepResult(step, stepOutputRaw, node.nodeId);
        path.push({ stepId: step.stepId, kind: step.kind, outcome });

        const transition = transitionByKey.get(transitionKey(step.stepId, outcome));
        if (!transition) {
          // Compiler-proven exhaustive — a miss is a diverged/tampered flow.
          throw new PipelineStageError(
            "gate_flow_transition_missing",
            false,
            new Error(`gate outcome ${step.stepId}.${outcome} has no transition in compiled flow ${flow.flow.id}@${flow.flow.version}`),
            "shard"
          );
        }

        if (transition.kind === "advance" || transition.kind === "internal_escalation") {
          currentStepId = transition.targetStepId;
          currentInput = output;
          continue;
        }

        spent.elapsedMs = Math.max(0, now() - startedAtMs);
        const resultCommon = {
          schemaVersion: GATE_NODE_RESULT_SCHEMA_VERSION,
          flow: { id: flow.flow.id, version: flow.flow.version, compiledDigest: flow.compiledDigest },
          certificateDigest: flow.terminationCertificate.certificateDigest,
          path,
          budgetSpent: spent
        } as const;

        if (transition.kind === "valid_decision") {
          const result: GateNodeResult = {
            ...resultCommon,
            disposition: "valid_decision",
            decision: { contract: transition.decisionContract, output }
          };
          return result;
        }

        // human_escalation — the SECOND proven terminal: the node SUCCEEDS
        // with the escalation arm, and the event (dedupe-keyed) rides the
        // node's atomic success append via the escalation ledger.
        const escalation = {
          reasonCode: transition.reasonCode,
          sourceStepId: transition.sourceStepId,
          outcomeCode: transition.outcomeCode
        };
        options.onEscalation?.({
          runId: invocation.runId,
          itemId: invocation.itemId,
          nodeId: node.nodeId,
          stage: { id: node.stage.id, version: node.stage.version },
          attempt: invocation.attempt,
          flow: { id: flow.flow.id, version: flow.flow.version, compiledDigest: flow.compiledDigest },
          certificateDigest: flow.terminationCertificate.certificateDigest,
          ...escalation,
          budgetSpent: spent
        });
        const result: GateNodeResult = {
          ...resultCommon,
          disposition: "human_escalation",
          escalation
        };
        return result;
      }
    }
  };
}
