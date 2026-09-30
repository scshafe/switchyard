// execute/fake-model.ts — a deterministic model port for first runs and tests.
//
// A model turn must return exactly one usage receipt, and a receipt has
// trust-tier rules a newcomer cannot guess. `fakeModelPort` answers each
// model node from a host rule (an outcome, a completion, or a function of the
// input) and attaches a no-telemetry receipt, so a graph runs end to end with
// no model server. Swap it for a real `ModelNodePort` without touching the
// graph; `providerReportedUsageReceipt` is the receipt such a port returns
// when its provider reports token counts.

import { types as nodeTypes } from "node:util";

import type { ArtifactEnvelope } from "../contracts/artifact.js";
import {
  UNAVAILABLE_USAGE_FLOOR,
  USAGE_RECEIPT_BOUNDS,
  USAGE_RECEIPT_SCHEMA_VERSION,
  validateUsageReceipt,
  type UsageReceipt
} from "../contracts/usage-receipt.js";
import { captureCapabilityRecord } from "../internal/capability.js";
import { assertIdentifier } from "../internal/guards.js";
import { ExecutionFailureError } from "./failure.js";
import type {
  ModelNodePort,
  ModelNodeTurnCompletion,
  WorkerNodeTurnContext
} from "./ports.js";

/**
 * The receipt for a model turn with no provider telemetry: trust
 * `unavailable`, charging the policy floor (never a silent zero).
 */
export function unavailableUsageReceipt(durationMs = 0): UsageReceipt {
  if (
    typeof durationMs !== "number"
    || !Number.isInteger(durationMs)
    || durationMs < 0
    || durationMs > USAGE_RECEIPT_BOUNDS.maxDurationMs
  ) {
    throw new Error(`unavailableUsageReceipt: durationMs must be an integer in 0..${USAGE_RECEIPT_BOUNDS.maxDurationMs}`);
  }
  return Object.freeze({
    schemaVersion: USAGE_RECEIPT_SCHEMA_VERSION,
    trust: "unavailable",
    observedInputTokens: null,
    observedOutputTokens: null,
    chargedTokens: UNAVAILABLE_USAGE_FLOOR.chargedTokens,
    observedCostMicroUsd: null,
    chargedCostMicroUsd: UNAVAILABLE_USAGE_FLOOR.chargedCostMicroUsd,
    durationMs
  });
}

export interface ProviderReportedUsage {
  /** Prompt tokens the provider reported. */
  readonly inputTokens: number;
  /** Completion tokens the provider reported. */
  readonly outputTokens: number;
  /** What the call is charged, in micro-USD: 0 for a local server with no price. */
  readonly chargedCostMicroUsd: number;
  readonly durationMs?: number;
}

/**
 * The receipt for a model turn whose provider reported its token counts
 * (trust `provider_reported`): the observed tokens, charged as their sum, and
 * the cost the host charges for them. When the provider reports no usage,
 * use `unavailableUsageReceipt` instead; never report missing counts as 0.
 */
export function providerReportedUsageReceipt(usage: ProviderReportedUsage): UsageReceipt {
  const raw = captureCapabilityRecord(
    usage,
    ["inputTokens", "outputTokens", "chargedCostMicroUsd", "durationMs"],
    ["inputTokens", "outputTokens", "chargedCostMicroUsd"],
    "providerReportedUsageReceipt input"
  );
  const tokens = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > USAGE_RECEIPT_BOUNDS.maxChargedTokens) {
      throw new Error(`providerReportedUsageReceipt: ${label} must be an integer in 0..${USAGE_RECEIPT_BOUNDS.maxChargedTokens}`);
    }
    return value;
  };
  const inputTokens = tokens(raw.inputTokens, "inputTokens");
  const outputTokens = tokens(raw.outputTokens, "outputTokens");
  return validateUsageReceipt({
    schemaVersion: USAGE_RECEIPT_SCHEMA_VERSION,
    trust: "provider_reported",
    observedInputTokens: inputTokens,
    observedOutputTokens: outputTokens,
    chargedTokens: inputTokens + outputTokens,
    observedCostMicroUsd: null,
    chargedCostMicroUsd: raw.chargedCostMicroUsd,
    durationMs: raw.durationMs ?? 0
  });
}

/** An outcome, or an outcome with the artifact it carries onward. */
export type FakeModelAnswer =
  | string
  | { readonly outcome: string; readonly outputArtifact?: ArtifactEnvelope };

export type FakeModelRule =
  | FakeModelAnswer
  | ((input: unknown, context: WorkerNodeTurnContext) => FakeModelAnswer | Promise<FakeModelAnswer>);

export type FakeModelRules = Readonly<Record<string, FakeModelRule>>;

function captureRules(rulesRaw: unknown): FakeModelRules {
  const label = "fake model rules";
  if (
    rulesRaw === null
    || typeof rulesRaw !== "object"
    || nodeTypes.isProxy(rulesRaw)
    || (Object.getPrototypeOf(rulesRaw) !== Object.prototype && Object.getPrototypeOf(rulesRaw) !== null)
  ) {
    throw new Error(`${label} must be a plain non-Proxy data object`);
  }
  const captured = Object.create(null) as Record<string, FakeModelRule>;
  const descriptors = Object.getOwnPropertyDescriptors(rulesRaw);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new Error(`${label} has symbol keys`);
    assertIdentifier(key, `${label} node id`);
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    const rule = descriptor.value as unknown;
    const ok = typeof rule === "string"
      || (typeof rule === "function" && !nodeTypes.isProxy(rule))
      || (rule !== null && typeof rule === "object" && !nodeTypes.isProxy(rule));
    if (!ok) throw new Error(`${label}.${key} must be an outcome, a completion or a function`);
    captured[key] = rule as FakeModelRule;
  }
  return Object.freeze(captured);
}

function missingRuleMessage(nodeId: unknown, keys: readonly string[]): string {
  const node = typeof nodeId === "string" ? JSON.stringify(nodeId) : String(nodeId);
  const listed = keys.length === 0
    ? "it has none"
    : `it has rules for ${keys.map((key) => JSON.stringify(key)).join(", ")}`;
  const message = `no fake-model rule for node ${node}; ${listed}. Add a rule keyed by the node id to fakeModelPort({ ... })`;
  // A failure message is bounded evidence; long rule lists are cut.
  return message.length <= 1_000 ? message : `${message.slice(0, 997)}...`;
}

/**
 * A `ModelNodePort` that answers `rules[context.nodeId]` and attaches an
 * `unavailableUsageReceipt`. A string rule is the outcome; an object rule is
 * `{ outcome, outputArtifact? }`; a function rule receives the validated
 * input and the turn context and returns either. A node without a rule fails
 * terminally with `immutable_configuration_rejected` and the message
 * `no fake-model rule for node "X"; it has rules for "a", "b". ...`.
 */
export function fakeModelPort(rulesRaw: FakeModelRules): ModelNodePort {
  const rules = captureRules(rulesRaw);
  return Object.freeze({
    async invoke(input: unknown, _binding: unknown, context: WorkerNodeTurnContext): Promise<ModelNodeTurnCompletion> {
      const nodeId = (context as { readonly nodeId?: unknown } | null | undefined)?.nodeId;
      if (typeof nodeId !== "string" || !Object.hasOwn(rules, nodeId)) {
        throw new ExecutionFailureError(
          "immutable_configuration_rejected",
          false,
          undefined,
          missingRuleMessage(nodeId, Object.keys(rules))
        );
      }
      const started = Date.now();
      const rule = rules[nodeId]!;
      const answer = typeof rule === "function"
        ? await Reflect.apply(rule, undefined, [input, context])
        : rule;
      const durationMs = Math.min(Math.max(0, Date.now() - started), USAGE_RECEIPT_BOUNDS.maxDurationMs);
      const completion = typeof answer === "string" ? { outcome: answer } : answer;
      return {
        ...(completion as { outcome: string; outputArtifact?: ArtifactEnvelope }),
        usage: [unavailableUsageReceipt(durationMs)]
      } as ModelNodeTurnCompletion;
    }
  });
}
