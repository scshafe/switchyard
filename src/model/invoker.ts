// model/invoker.ts — the ModelBindingResolver PORT + createModelNodeInvoker:
// the NodeInvoker arm for kind:"model" compiled nodes.
//
// PROMOTED from inbox-pipeline/src/catalog/model-resolver.ts (the resolve-a-
// sealed-binding-to-an-invoker shape with its identity cross-checks — model /
// profile / prompt-stack / persona digests must all agree) and the receipt
// plumbing of src/usage-receipt.ts, RE-CUT over the B3 NodeInvoker port: the
// durable executor already owns idempotency, retries, dead letters, and
// contract validation, so this invoker performs exactly ONE attempt and throws
// typed PipelineStageErrors for routing.
//
// THE RECEIPT FLOOR (the inbox classification silent-zero gap, closed at
// FRAMEWORK level): EVERY completed model invocation MUST return a
// usage-receipt.v1. A missing receipt, a malformed receipt, or a receipt whose
// trust ∈ {estimated_tier_ceiling, unavailable} charges below 1 token / 1
// micro-USD is a TERMINAL, non-retryable failure — "no telemetry" can never
// masquerade as free usage, and a resolver that forgets its receipt can never
// ship work through this node kind.
//
// Receipts reach persistence two ways (both host-visible):
//   - `onReceipt` fires for EVERY validated receipt (including attempts whose
//     output later fails contract validation);
//   - createModelReceiptLedger() pairs an onReceipt collector with an
//     `outboxEventsFor` hook for ShardRunnerOptions, so the SUCCESS receipt
//     rides ATOMICALLY with persistStageSuccess through the transactional
//     outbox.
//
// INFERENCE CONCURRENCY (optional): the promoted worker capacity fence, re-cut
// over the PipelineStore auxiliary leases — slot keys
// `inference:<profileId>@<version>:<slot>`, lease TTL strictly above the
// profile timeout so a live call can never outlive its fence. Contention is a
// RETRYABLE item failure; a lost capacity fence discovered at release time is
// swallowed (the lease protects capacity, not evidence — a completed call's
// result and receipt must not be discarded for it).
//
// STANDALONE: node: + relative imports only (no npm deps, no zod).

import { setTimeout as sleep } from "node:timers/promises";

import { isPlainObject } from "../internal/guards.js";
import { validateUsageReceipt, type UsageReceipt } from "../contracts/usage-receipt.js";
import type { ContractValidator } from "../catalog.js";
import type { CompiledPipelineNode } from "../compile.js";
import {
  WorkLeaseLostError,
  type OutboxEventInput,
  type PipelineStore,
  type WorkLease
} from "../store.js";
import { PipelineStageError } from "../execute/durable-stage.js";
import type { NodeInvocation, NodeInvoker } from "../execute/shard-runner.js";
import { validateCompiledPrompt, type CompiledPrompt } from "../prompt/compiler.js";
import { validateModelStageBinding, type ModelStageBinding } from "./binding.js";

// ── The ModelBindingResolver port ─────────────────────────────────────────

/** What the resolved invoker receives for ONE physical model call. */
export interface ModelInvocationRequest {
  runId: string;
  itemId: string;
  nodeId: string;
  stage: { id: string; version: number };
  attempt: number;
  /** The composed, contract-validated stage input. */
  input: unknown;
  /** The sealed binding this invoker was resolved from (identity convenience). */
  binding: ModelStageBinding;
}

/** One completed call: the raw model output + its MANDATORY usage receipt. */
export interface ModelInvocationResult {
  output: unknown;
  usage: UsageReceipt;
}

/**
 * A resolver-produced invoker for ONE sealed binding. When the binding carries
 * a `promptStackRef`, the resolver MUST surface the compiled prompt it will
 * use — createModelNodeInvoker verifies the compiled prompt's identity against
 * the binding (the promoted prompt-identity check).
 */
export interface ResolvedModelBinding {
  invoke(request: ModelInvocationRequest, signal?: AbortSignal): Promise<ModelInvocationResult>;
  compiledPrompt?: CompiledPrompt;
}

/**
 * The injected model-execution port (hosts bind their provider adapters here;
 * inbox's openai-compatible adapter is the reference implementation). The
 * binding a resolver receives is ALREADY validated (digest-sealed, recorded
 * parameters fail-closed) and matches the node's bindingFingerprint exactly.
 */
export interface ModelBindingResolver {
  resolve(binding: ModelStageBinding): ResolvedModelBinding | Promise<ResolvedModelBinding>;
}

// ── Receipt records + the outbox-riding ledger ────────────────────────────

/** One validated receipt, attributed to its exact attempt. */
export interface ModelUsageReceiptRecord {
  runId: string;
  itemId: string;
  nodeId: string;
  stage: { id: string; version: number };
  attempt: number;
  bindingDigest: string;
  receipt: UsageReceipt;
}

export const MODEL_USAGE_RECEIPT_EVENT_TYPE = "model_usage_receipt";
export const MODEL_USAGE_RECEIPT_EVENT_SCHEMA_VERSION = "model-usage-receipt-event.v1";

export interface ModelReceiptLedger {
  /** Every validated receipt observed, in order (failed-output attempts included). */
  readonly records: readonly ModelUsageReceiptRecord[];
  /** Wire as createModelNodeInvoker's onReceipt. */
  onReceipt(record: ModelUsageReceiptRecord): void;
  /**
   * Wire as ShardRunnerOptions.outboxEventsFor: drains this (itemId, nodeId)'s
   * pending receipts into outbox events that ride ATOMICALLY with the node's
   * fresh persistStageSuccess append.
   */
  outboxEventsFor(context: { node: CompiledPipelineNode; itemId: string; output: unknown }): OutboxEventInput[];
}

/**
 * The receipt→outbox bridge: receipts recorded during an attempt ride the
 * SAME atomic append as the stage success. Receipts whose attempt never
 * reaches persistStageSuccess (e.g. the output later fails its contract) stay
 * in `records` for host-side persistence.
 */
export function createModelReceiptLedger(): ModelReceiptLedger {
  const records: ModelUsageReceiptRecord[] = [];
  const pending = new Map<string, ModelUsageReceiptRecord[]>();
  const keyOf = (itemId: string, nodeId: string): string => `${itemId} ${nodeId}`;
  return {
    get records(): readonly ModelUsageReceiptRecord[] {
      return records.slice();
    },
    onReceipt(record: ModelUsageReceiptRecord): void {
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
        eventType: MODEL_USAGE_RECEIPT_EVENT_TYPE,
        payload: {
          schemaVersion: MODEL_USAGE_RECEIPT_EVENT_SCHEMA_VERSION,
          runId: record.runId,
          itemId: record.itemId,
          nodeId: record.nodeId,
          stage: record.stage,
          attempt: record.attempt,
          bindingDigest: record.bindingDigest,
          receipt: record.receipt
        },
        dedupeKey: `model-receipt:${record.runId}:${record.itemId}:${record.nodeId}:${record.attempt}`
      }));
    }
  };
}

// ── createModelNodeInvoker ────────────────────────────────────────────────

/** Optional inference-concurrency fencing over the store's auxiliary leases. */
export interface ModelConcurrencyOptions {
  store: Pick<PipelineStore, "acquireLease" | "releaseLease">;
  leaseOwner: string;
  /** Parallel slots per inference profile; default = the profile's recorded maxConcurrency. */
  slots?: number;
  /** Lease TTL; MUST exceed the profile's timeoutMs. Default timeoutMs + 60_000. */
  leaseDurationMs?: number;
  /** How long to wait for a free slot before the retryable capacity failure. Default 0 (single sweep). */
  acquireTimeoutMs?: number;
  /** Poll cadence while waiting. Default 25ms. */
  pollMs?: number;
  now?: () => Date;
}

export interface ModelNodeInvokerOptions {
  resolver: ModelBindingResolver;
  /** The published sealed bindings this invoker may execute (validated LOUDLY up front). */
  bindings: readonly unknown[];
  /**
   * The catalog's ContractValidator: every binding's recorded responseContract
   * must be KNOWN (fail closed at construction — an unknown response contract
   * can never reach a provider).
   */
  catalogContracts: ContractValidator;
  /** Fires for EVERY validated receipt (see the module header). */
  onReceipt?: (record: ModelUsageReceiptRecord) => void;
  /** Non-model node kinds delegate here (B5 gate / B6 agent arms); absent ⇒ LOUD. */
  fallback?: NodeInvoker;
  concurrency?: ModelConcurrencyOptions;
}

function assertContractValidator(value: unknown): ContractValidator {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as ContractValidator).knows !== "function" ||
    typeof (value as ContractValidator).validate !== "function"
  ) {
    throw new Error(
      "createModelNodeInvoker: catalogContracts must implement the ContractValidator port { knows(contractId), validate(contractId, value) }"
    );
  }
  return value as ContractValidator;
}

/**
 * Build the kind:"model" NodeInvoker arm. Per invocation it:
 * 1. resolves the compiled node's bindingFingerprint to its published sealed
 *    binding (unknown fingerprint ⇒ TERMINAL shard-scoped — immutable
 *    configuration, the digest-must-match rule);
 * 2. resolves the binding through the ModelBindingResolver port ONCE (cached
 *    per bindingDigest) and verifies the promoted prompt-identity check: when
 *    the binding names a prompt stack, the resolver's compiled prompt must be
 *    digest-valid and its promptStack/persona identity must EQUAL the
 *    binding's refs;
 * 3. optionally acquires an inference-concurrency lease slot;
 * 4. invokes ONCE (the durable executor owns retries) and ENFORCES the receipt
 *    floor: missing/malformed/below-floor receipts are TERMINAL, non-retryable
 *    item failures — every completed call records a receipt via onReceipt.
 */
export function createModelNodeInvoker(options: ModelNodeInvokerOptions): NodeInvoker {
  if (options === null || typeof options !== "object") {
    throw new Error("createModelNodeInvoker: options must be an object");
  }
  const resolver = options.resolver;
  if (resolver === null || typeof resolver !== "object" || typeof resolver.resolve !== "function") {
    throw new Error("createModelNodeInvoker: resolver must implement the ModelBindingResolver port { resolve(binding) }");
  }
  const contracts = assertContractValidator(options.catalogContracts);
  if (!Array.isArray(options.bindings)) {
    throw new Error("createModelNodeInvoker: bindings must be an array of sealed ModelStageBindings");
  }
  // Validate every published binding LOUDLY up front; index by sealed digest.
  const bindingsByDigest = new Map<string, ModelStageBinding>();
  for (const raw of options.bindings) {
    const binding = validateModelStageBinding(raw);
    if (bindingsByDigest.has(binding.bindingDigest)) {
      throw new Error(
        `createModelNodeInvoker: duplicate model binding digest ${binding.bindingDigest} (${binding.bindingId}@${binding.version})`
      );
    }
    // Fail closed at construction: the recorded response contract must be known.
    const responseContract = binding.inferenceProfileRef.parameters.responseContract;
    if (!contracts.knows(responseContract)) {
      throw new Error(
        `createModelNodeInvoker: binding ${binding.bindingId}@${binding.version} records response contract ${responseContract}, which the catalog ContractValidator does not know (fail closed)`
      );
    }
    bindingsByDigest.set(binding.bindingDigest, binding);
  }

  const resolvedCache = new Map<string, ResolvedModelBinding>();

  async function resolveVerified(binding: ModelStageBinding): Promise<ResolvedModelBinding> {
    const cached = resolvedCache.get(binding.bindingDigest);
    if (cached) return cached;
    const resolved = await resolver.resolve(binding);
    if (resolved === null || typeof resolved !== "object" || typeof resolved.invoke !== "function") {
      throw new PipelineStageError(
        "model_resolver_invalid",
        false,
        new Error(`resolver returned no invoke() for binding ${binding.bindingId}@${binding.version}`),
        "shard"
      );
    }
    // The promoted prompt-identity check: resolved prompt digest-valid AND
    // identical to the binding's promptStack/persona refs.
    if (binding.promptStackRef !== undefined) {
      if (resolved.compiledPrompt === undefined) {
        throw new PipelineStageError(
          "model_prompt_identity_mismatch",
          false,
          new Error(
            `binding ${binding.bindingId}@${binding.version} names prompt stack ${binding.promptStackRef.id}@${binding.promptStackRef.version} but the resolver surfaced no compiled prompt`
          ),
          "shard"
        );
      }
      let prompt: CompiledPrompt;
      try {
        prompt = validateCompiledPrompt(resolved.compiledPrompt);
      } catch (error) {
        throw new PipelineStageError("model_prompt_identity_mismatch", false, error, "shard");
      }
      const stackRef = binding.promptStackRef;
      if (
        prompt.promptStack.id !== stackRef.id ||
        prompt.promptStack.version !== stackRef.version ||
        prompt.promptStack.digest !== stackRef.digest
      ) {
        throw new PipelineStageError(
          "model_prompt_identity_mismatch",
          false,
          new Error(
            `resolved prompt stack ${prompt.promptStack.id}@${prompt.promptStack.version} (${prompt.promptStack.digest}) does not match binding ${binding.bindingId}@${binding.version} prompt stack ${stackRef.id}@${stackRef.version} (${stackRef.digest})`
          ),
          "shard"
        );
      }
      const personaRef = binding.personaRef;
      if (
        personaRef !== undefined &&
        (prompt.persona.id !== personaRef.id ||
          prompt.persona.version !== personaRef.version ||
          prompt.persona.digest !== personaRef.digest)
      ) {
        throw new PipelineStageError(
          "model_prompt_identity_mismatch",
          false,
          new Error(
            `resolved prompt persona ${prompt.persona.id}@${prompt.persona.version} does not match binding ${binding.bindingId}@${binding.version} persona ${personaRef.id}@${personaRef.version}`
          ),
          "shard"
        );
      }
    }
    resolvedCache.set(binding.bindingDigest, resolved);
    return resolved;
  }

  async function acquireSlot(binding: ModelStageBinding): Promise<{ lease: WorkLease; store: ModelConcurrencyOptions["store"] } | undefined> {
    const concurrency = options.concurrency;
    if (concurrency === undefined) return undefined;
    const profile = binding.inferenceProfileRef;
    const slots = concurrency.slots ?? profile.parameters.maxConcurrency;
    if (!Number.isInteger(slots) || slots < 1 || slots > 4096) {
      throw new PipelineStageError(
        "model_concurrency_misconfigured",
        false,
        new Error(`slots must be an integer >= 1 (got ${String(slots)})`),
        "shard"
      );
    }
    const leaseDurationMs = concurrency.leaseDurationMs ?? profile.parameters.timeoutMs + 60_000;
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= profile.parameters.timeoutMs) {
      // The fence must strictly outlive the longest possible call so a live
      // invocation can never lose its capacity lease mid-flight.
      throw new PipelineStageError(
        "model_concurrency_misconfigured",
        false,
        new Error(
          `leaseDurationMs (${String(leaseDurationMs)}) must exceed the profile timeoutMs (${profile.parameters.timeoutMs})`
        ),
        "shard"
      );
    }
    const pollMs = concurrency.pollMs ?? 25;
    const now = concurrency.now ?? (() => new Date());
    const deadline = now().getTime() + (concurrency.acquireTimeoutMs ?? 0);
    while (true) {
      for (let slot = 0; slot < slots; slot += 1) {
        const lease = await concurrency.store.acquireLease({
          leaseKey: `inference:${profile.id}@${profile.version}:${slot}`,
          leaseOwner: concurrency.leaseOwner,
          leaseDurationMs,
          at: now().toISOString()
        });
        if (lease) return { lease, store: concurrency.store };
      }
      if (now().getTime() >= deadline) {
        throw new PipelineStageError(
          "inference_capacity_exhausted",
          true,
          new Error(`all ${slots} inference slot(s) for profile ${profile.id}@${profile.version} are leased`),
          "item"
        );
      }
      await sleep(pollMs);
    }
  }

  return {
    async invoke(invocation: NodeInvocation): Promise<unknown> {
      const { node } = invocation;
      if (node.kind !== "model") {
        if (options.fallback) return options.fallback.invoke(invocation);
        throw new PipelineStageError(
          "model_invoker_wrong_kind",
          false,
          new Error(`createModelNodeInvoker handles kind "model" only; node ${node.nodeId} is kind "${node.kind}" and no fallback invoker is configured`),
          "shard"
        );
      }
      const binding = bindingsByDigest.get(node.bindingFingerprint);
      if (!binding) {
        // The compiled node's sealed fingerprint names no published binding —
        // immutable configuration, LOUD (the digest-must-match rule).
        throw new PipelineStageError(
          "model_binding_unresolved",
          false,
          new Error(`no published model binding matches bindingFingerprint ${node.bindingFingerprint} (node ${node.nodeId})`),
          "shard"
        );
      }
      const resolved = await resolveVerified(binding);
      const slot = await acquireSlot(binding);
      try {
        const result = await resolved.invoke(
          {
            runId: invocation.runId,
            itemId: invocation.itemId,
            nodeId: node.nodeId,
            stage: { id: node.stage.id, version: node.stage.version },
            attempt: invocation.attempt,
            input: invocation.input,
            binding
          },
          invocation.signal
        );

        // ── THE RECEIPT FLOOR ──────────────────────────────────────────────
        if (!isPlainObject(result) || !("output" in result)) {
          throw new PipelineStageError(
            "model_result_malformed",
            false,
            new Error(`resolver for binding ${binding.bindingId}@${binding.version} returned no { output, usage } result`),
            "item"
          );
        }
        if (!("usage" in result) || result.usage === undefined || result.usage === null) {
          throw new PipelineStageError(
            "model_receipt_missing",
            false,
            new Error(
              `model invocation for node ${node.nodeId} (binding ${binding.bindingId}@${binding.version}) completed WITHOUT a usage receipt — every attempt must record one`
            ),
            "item"
          );
        }
        let receipt: UsageReceipt;
        try {
          receipt = validateUsageReceipt(result.usage);
        } catch (error) {
          // Includes the non-silent-zero floor: estimated_tier_ceiling /
          // unavailable receipts charging 0 are rejected here — TERMINAL.
          throw new PipelineStageError("model_receipt_rejected", false, error, "item");
        }
        options.onReceipt?.({
          runId: invocation.runId,
          itemId: invocation.itemId,
          nodeId: node.nodeId,
          stage: { id: node.stage.id, version: node.stage.version },
          attempt: invocation.attempt,
          bindingDigest: binding.bindingDigest,
          receipt
        });
        return result.output;
      } finally {
        if (slot) {
          try {
            await slot.store.releaseLease({ leaseKey: slot.lease.leaseKey, leaseToken: slot.lease.leaseToken });
          } catch (error) {
            // A lost capacity fence after completed work is swallowed: the
            // lease protects capacity, not evidence — never discard a
            // completed result (and its receipt) over it.
            if (!(error instanceof WorkLeaseLostError)) throw error;
          }
        }
      }
    }
  };
}
