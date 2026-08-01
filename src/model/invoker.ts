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
//   - createModelReceiptLedger() pairs an onReceipt collector with success and
//     failure attempt hooks for ShardRunnerOptions, so every admitted receipt
//     rides ATOMICALLY with the exact attempt that incurred it.
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
import {
  assertEvidenceAttemptIdentity,
  assertEvidenceDigest,
  assertEvidenceString,
  deepFrozenClone,
  snapshotEvidenceOutboxContext
} from "../internal/evidence.js";
import {
  captureCapabilityDataProperty,
  captureCapabilityMethod,
  captureCapabilityRecord
} from "../internal/capability.js";
import { digest } from "../contracts/digest.js";
import type { ContractId } from "../contracts/artifact.js";
import { validateUsageReceipt, type UsageReceipt } from "../contracts/usage-receipt.js";
import type { ContractValidator } from "../catalog.js";
import type { CompiledPipelineNode } from "../compile.js";
import {
  EvidenceConflictError,
  type OutboxEventInput,
  type PipelineStore,
  type RetrySafeOutboxEvents,
  type WorkLease
} from "../store.js";
import { PipelineStageError, StageEvidenceAssemblyError } from "../execute/durable-stage.js";
import { createRetrySafeOutboxEvents } from "../execute/outbox.js";
import { snapshotNodeInvocation, type NodeInvocation, type NodeInvoker } from "../execute/shard-runner.js";
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
  /**
   * Stable provider-attempt key. A kind:"model" node derives it from the
   * durable stage action key plus attempt number; gate model steps also bind
   * flow/step/model positions (see gate/executor.ts).
   */
  idempotencyKey: string;
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
  /** Stable durable-stage action namespace. */
  idempotencyKey: string;
  /**
   * Exact provider-attempt key, deterministically derived from idempotencyKey
   * and the attempt (plus gate step positions for an embedded model step).
   */
  providerIdempotencyKey: string;
  bindingDigest: string;
  receipt: UsageReceipt;
  /**
   * Present when the receipt was charged by a MODEL STEP inside a kind:"gate"
   * node (gate/executor.ts): one gate attempt may run several model steps, so
   * the step id disambiguates the ledger's outbox dedupe keys.
   */
  gateStepId?: string;
}

export const MODEL_USAGE_RECEIPT_EVENT_TYPE = "model_usage_receipt";
export const MODEL_USAGE_RECEIPT_EVENT_SCHEMA_VERSION = "model-usage-receipt-event.v1";

export interface ModelReceiptOutboxContext {
  runId: string;
  node: CompiledPipelineNode;
  itemId: string;
  /** Retained for source compatibility with the original success-only hook. */
  output?: unknown;
  attempt: number;
  /** Stable durable-stage action namespace. */
  idempotencyKey: string;
}

export interface ModelReceiptLedger {
  /** Every validated receipt observed, in order (failed-output attempts included). */
  readonly records: readonly ModelUsageReceiptRecord[];
  /** Wire as createModelNodeInvoker's onReceipt. */
  onReceipt(record: ModelUsageReceiptRecord): void;
  /**
   * Wire as ShardRunnerOptions.outboxEventsFor: drains this exact
   * (runId, itemId, nodeId, attempt)'s pending receipts into outbox events
   * that ride ATOMICALLY with the node's fresh persistStageSuccess append.
   */
  outboxEventsFor(context: ModelReceiptOutboxContext): RetrySafeOutboxEvents;
  /**
   * Wire as ShardRunnerOptions.failureOutboxEventsFor: the same exact-tuple
   * drain, used when a provider call was billable but its attempt failed.
   */
  failureOutboxEventsFor(context: ModelReceiptOutboxContext): RetrySafeOutboxEvents;
}

/**
 * The receipt→outbox bridge: receipts recorded during an attempt ride the
 * SAME atomic append as that attempt's success or failure. `records` remains
 * the immutable observation history. Each hook is a non-destructive peek;
 * acknowledgement removes only the exact peeked prefix after persistence.
 */
export function createModelReceiptLedger(): ModelReceiptLedger {
  const records: ModelUsageReceiptRecord[] = [];
  const pending = new Map<string, ModelUsageReceiptRecord[]>();
  const keyOf = (
    runId: string,
    itemId: string,
    nodeId: string,
    attempt: number,
    idempotencyKey: string
  ): string => JSON.stringify([
    runId,
    itemId,
    nodeId,
    attempt,
    idempotencyKey
  ]);
  const evidenceDigest = (record: ModelUsageReceiptRecord): string => digest({
    schemaVersion: "model-usage-receipt-evidence.v1",
    ...record
  });
  const peek = (context: ModelReceiptOutboxContext): RetrySafeOutboxEvents => {
    const identity = snapshotEvidenceOutboxContext(
      context,
      "model receipt outbox context"
    );
    const key = keyOf(
      identity.runId,
      identity.itemId,
      identity.nodeId,
      identity.attempt,
      identity.idempotencyKey
    );
    const queue = [...(pending.get(key) ?? [])];
    const events: OutboxEventInput[] = queue.map((record) => ({
      eventType: MODEL_USAGE_RECEIPT_EVENT_TYPE,
      payload: {
        schemaVersion: MODEL_USAGE_RECEIPT_EVENT_SCHEMA_VERSION,
        runId: record.runId,
        itemId: record.itemId,
        nodeId: record.nodeId,
        stage: record.stage,
        attempt: record.attempt,
        idempotencyKey: record.idempotencyKey,
        providerIdempotencyKey: record.providerIdempotencyKey,
        bindingDigest: record.bindingDigest,
        receipt: record.receipt,
        ...(record.gateStepId === undefined ? {} : { gateStepId: record.gateStepId })
      },
      dedupeKey:
        `model-receipt:${record.runId}:${record.itemId}:${record.nodeId}:${record.attempt}` +
        (record.gateStepId === undefined ? "" : `:step:${record.gateStepId}`) +
        `:action:${record.idempotencyKey}` +
        (record.providerIdempotencyKey === record.idempotencyKey
          ? ""
          : `:call:${record.providerIdempotencyKey}`) +
        `:evidence:${evidenceDigest(record)}`
    }));
    return createRetrySafeOutboxEvents(events, () => {
      const current = pending.get(key);
      if (current === undefined || queue.length === 0) return;
      const exactPrefix = queue.every((record, index) => current[index] === record);
      if (!exactPrefix) return;
      current.splice(0, queue.length);
      if (current.length === 0) pending.delete(key);
    });
  };
  return {
    get records(): readonly ModelUsageReceiptRecord[] {
      return records.map((record) => deepFrozenClone(record, "model usage receipt observation"));
    },
    onReceipt(record: ModelUsageReceiptRecord): void {
      const rawSnapshot = deepFrozenClone(record, "model usage receipt");
      assertEvidenceAttemptIdentity(rawSnapshot, "model usage receipt");
      assertEvidenceDigest(rawSnapshot.providerIdempotencyKey, "model usage receipt.providerIdempotencyKey");
      assertEvidenceDigest(rawSnapshot.bindingDigest, "model usage receipt.bindingDigest");
      if (rawSnapshot.gateStepId !== undefined) {
        assertEvidenceString(rawSnapshot.gateStepId, "model usage receipt.gateStepId");
      }
      const snapshot = deepFrozenClone(
        { ...rawSnapshot, receipt: validateUsageReceipt(rawSnapshot.receipt) },
        "model usage receipt"
      );
      const key = keyOf(
        snapshot.runId,
        snapshot.itemId,
        snapshot.nodeId,
        snapshot.attempt,
        snapshot.idempotencyKey
      );
      const queue = pending.get(key);
      if (queue) {
        const candidateDigest = evidenceDigest(snapshot);
        const logicalIdentity = `${snapshot.providerIdempotencyKey}:${snapshot.gateStepId ?? "direct"}`;
        const sameCall = queue.find(
          (candidate) =>
            candidate.providerIdempotencyKey === snapshot.providerIdempotencyKey
            && candidate.gateStepId === snapshot.gateStepId
        );
        if (sameCall !== undefined) {
          if (evidenceDigest(sameCall) !== candidateDigest) {
            throw new EvidenceConflictError("model usage receipt", logicalIdentity);
          }
          records.push(snapshot);
          return;
        }
        queue.push(snapshot);
      } else {
        pending.set(key, [snapshot]);
      }
      records.push(snapshot);
    },
    outboxEventsFor: peek,
    failureOutboxEventsFor: peek
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
  /**
   * Non-model node kinds delegate here (B5 gate / B6 agent arms); absent ⇒ LOUD.
   * This is an intentionally extensible capability object: only its `invoke`
   * data-property method is captured; unrelated members are ignored.
   */
  fallback?: NodeInvoker;
  concurrency?: ModelConcurrencyOptions;
}

function assertContractValidator(value: unknown): ContractValidator {
  let knows: (...args: any[]) => any;
  let validate: (...args: any[]) => any;
  try {
    knows = captureCapabilityMethod(value, "knows", "model contract validator");
    validate = captureCapabilityMethod(value, "validate", "model contract validator");
  } catch {
    throw new Error(
      "createModelNodeInvoker: catalogContracts must implement the ContractValidator port { knows(contractId), validate(contractId, value) }"
    );
  }
  return Object.freeze({
    knows: (contractId: ContractId) => knows(contractId),
    validate: (contractId: ContractId, payload: unknown) => validate(contractId, payload)
  });
}

/**
 * Verify a resolver-produced {@link ResolvedModelBinding} against its sealed
 * binding: the invoker must exist, and when the binding names a prompt stack
 * the resolver's compiled prompt must be digest-valid with promptStack/persona
 * identity EQUAL to the binding's refs (the promoted prompt-identity check).
 * Shared by createModelNodeInvoker and the gate executor's model steps
 * (gate/executor.ts) — one check, two callers. Throws typed shard-scoped
 * PipelineStageErrors.
 */
export function verifyResolvedModelBinding(resolvedRaw: unknown, binding: ModelStageBinding): ResolvedModelBinding {
  let invoke: (...args: any[]) => any;
  let compiledPromptRaw: unknown;
  try {
    invoke = captureCapabilityMethod(resolvedRaw, "invoke", "resolved model binding");
    compiledPromptRaw = captureCapabilityDataProperty(
      resolvedRaw,
      "compiledPrompt",
      "resolved model binding"
    );
  } catch {
    throw new PipelineStageError(
      "model_resolver_invalid",
      false,
      new Error(`resolver returned no invoke() for binding ${binding.bindingId}@${binding.version}`),
      "shard"
    );
  }
  let compiledPrompt: CompiledPrompt | undefined;
  // The promoted prompt-identity check: resolved prompt digest-valid AND
  // identical to the binding's promptStack/persona refs.
  if (binding.promptStackRef !== undefined) {
    if (compiledPromptRaw === undefined) {
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
      prompt = validateCompiledPrompt(compiledPromptRaw);
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
    compiledPrompt = prompt;
  }
  return Object.freeze({
    invoke: (request: ModelInvocationRequest, signal?: AbortSignal) =>
      invoke(request, signal),
    ...(compiledPrompt === undefined ? {} : { compiledPrompt })
  });
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
  options = captureCapabilityRecord(
    options,
    ["resolver", "bindings", "catalogContracts", "onReceipt", "fallback", "concurrency"],
    ["resolver", "bindings", "catalogContracts"],
    "createModelNodeInvoker options"
  ) as unknown as ModelNodeInvokerOptions;
  let resolveBinding: (...args: any[]) => any;
  try {
    resolveBinding = captureCapabilityMethod(
      options.resolver,
      "resolve",
      "model binding resolver"
    );
  } catch {
    throw new Error("createModelNodeInvoker: resolver must implement the ModelBindingResolver port { resolve(binding) }");
  }
  const contracts = assertContractValidator(options.catalogContracts);
  const onReceipt = options.onReceipt;
  if (onReceipt !== undefined && typeof onReceipt !== "function") {
    throw new Error("createModelNodeInvoker: onReceipt must be a function");
  }
  const fallback = options.fallback === undefined
    ? undefined
    : Object.freeze({
        invoke: captureCapabilityMethod(
          options.fallback,
          "invoke",
          "model fallback invoker"
        )
      });
  const concurrency = (() => {
    if (options.concurrency === undefined) return undefined;
    const raw = captureCapabilityRecord(
      options.concurrency,
      ["store", "leaseOwner", "slots", "leaseDurationMs", "acquireTimeoutMs", "pollMs", "now"],
      ["store", "leaseOwner"],
      "model concurrency options"
    );
    const store = captureCapabilityDataProperty(
      raw,
      "store",
      "model concurrency options"
    );
    const acquireLease = captureCapabilityMethod(
      store,
      "acquireLease",
      "model concurrency store"
    );
    const releaseLease = captureCapabilityMethod(
      store,
      "releaseLease",
      "model concurrency store"
    );
    const now = captureCapabilityDataProperty(
      raw,
      "now",
      "model concurrency options"
    ) ?? (() => new Date());
    if (typeof now !== "function") {
      throw new Error("createModelNodeInvoker: concurrency.now must be a function");
    }
    return Object.freeze({
      acquireLease,
      releaseLease,
      leaseOwner: captureCapabilityDataProperty(raw, "leaseOwner", "model concurrency options") as string,
      slots: captureCapabilityDataProperty(raw, "slots", "model concurrency options") as number | undefined,
      leaseDurationMs: captureCapabilityDataProperty(raw, "leaseDurationMs", "model concurrency options") as number | undefined,
      acquireTimeoutMs: captureCapabilityDataProperty(raw, "acquireTimeoutMs", "model concurrency options") as number | undefined,
      pollMs: captureCapabilityDataProperty(raw, "pollMs", "model concurrency options") as number | undefined,
      now: now as () => Date
    });
  })();
  if (!Array.isArray(options.bindings)) {
    throw new Error("createModelNodeInvoker: bindings must be an array of sealed ModelStageBindings");
  }
  const bindingEntries = deepFrozenClone(
    options.bindings,
    "createModelNodeInvoker bindings"
  ) as readonly unknown[];
  // Validate every published binding LOUDLY up front; index by sealed digest.
  const bindingsByDigest = new Map<string, ModelStageBinding>();
  for (const raw of bindingEntries) {
    const binding = deepFrozenClone(
      validateModelStageBinding(raw),
      "published model binding"
    );
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
    const resolved = verifyResolvedModelBinding(await resolveBinding(binding), binding);
    resolvedCache.set(binding.bindingDigest, resolved);
    return resolved;
  }

  async function acquireSlot(binding: ModelStageBinding): Promise<{
    lease: WorkLease;
    releaseLease: (...args: any[]) => any;
  } | undefined> {
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
    const now = concurrency.now;
    const deadline = now().getTime() + (concurrency.acquireTimeoutMs ?? 0);
    while (true) {
      for (let slot = 0; slot < slots; slot += 1) {
        const lease = await concurrency.acquireLease({
          leaseKey: `inference:${profile.id}@${profile.version}:${slot}`,
          leaseOwner: concurrency.leaseOwner,
          leaseDurationMs,
          at: now().toISOString()
        });
        if (lease) return { lease, releaseLease: concurrency.releaseLease };
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
      invocation = snapshotNodeInvocation(invocation);
      const { node } = invocation;
      if (node.kind !== "model") {
        if (fallback) return fallback.invoke(invocation);
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
        const stageIdempotencyKey = assertEvidenceDigest(
          invocation.idempotencyKey,
          "model invocation.idempotencyKey"
        );
        const providerIdempotencyKey = digest({
          schemaVersion: "model-provider-attempt-idempotency.v1",
          stageIdempotencyKey,
          attempt: invocation.attempt
        });
        const providerRequest = deepFrozenClone(
          {
            runId: invocation.runId,
            itemId: invocation.itemId,
            nodeId: node.nodeId,
            stage: { id: node.stage.id, version: node.stage.version },
            attempt: invocation.attempt,
            idempotencyKey: providerIdempotencyKey,
            input: invocation.input,
            binding
          },
          "model provider request"
        );
        const resultRaw = await resolved.invoke(
          providerRequest,
          invocation.signal
        );
        let result: ModelInvocationResult;
        try {
          result = deepFrozenClone(resultRaw, "resolved model result");
        } catch (error) {
          throw new PipelineStageError(
            "model_result_malformed",
            false,
            error,
            "item"
          );
        }

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
          receipt = deepFrozenClone(
            validateUsageReceipt(result.usage),
            "model usage receipt"
          );
        } catch (error) {
          // Includes the non-silent-zero floor: estimated_tier_ceiling /
          // unavailable receipts charging 0 are rejected here — TERMINAL.
          throw new PipelineStageError("model_receipt_rejected", false, error, "item");
        }
        try {
          onReceipt?.(deepFrozenClone({
            runId: invocation.runId,
            itemId: invocation.itemId,
            nodeId: node.nodeId,
            stage: { id: node.stage.id, version: node.stage.version },
            attempt: invocation.attempt,
            idempotencyKey: stageIdempotencyKey,
            providerIdempotencyKey,
            bindingDigest: binding.bindingDigest,
            receipt
          }, "model usage receipt callback record"));
        } catch (error) {
          if (error instanceof EvidenceConflictError || error instanceof StageEvidenceAssemblyError) throw error;
          throw new StageEvidenceAssemblyError("provider_receipt", error);
        }
        const responseContract =
          binding.inferenceProfileRef.parameters.responseContract;
        const validatedOutput = contracts.validate(
          responseContract,
          result.output
        );
        if (!validatedOutput.ok) {
          const details = validatedOutput.issues
            .map((issue) =>
              `${issue.path === undefined ? "" : `${issue.path}: `}${issue.message}`
            )
            .join("; ");
          throw new PipelineStageError(
            "model_output_contract_invalid",
            true,
            new Error(
              `model response contract ${responseContract} rejected output` +
              (details.length === 0 ? "" : `: ${details}`)
            ),
            "item"
          );
        }
        return validatedOutput.value;
      } finally {
        if (slot) {
          try {
            await slot.releaseLease({ leaseKey: slot.lease.leaseKey, leaseToken: slot.lease.leaseToken });
          } catch {
            // Capacity-lease cleanup is never allowed to turn an already
            // completed provider call into a retryable stage failure. Doing so
            // could replay the physical call under the next attempt. Hosts
            // observe/repair capacity-store cleanup independently.
          }
        }
      }
    }
  };
}
