// execute/fake-model.ts — a deterministic model port for first runs and tests.
//
// A model turn must return exactly one usage receipt, and a receipt has
// trust-tier rules a newcomer cannot guess. `fakeModelPort` answers each
// model node from a host rule (an outcome, a completion, or a function of the
// input) and attaches a no-telemetry receipt, so a graph runs end to end with
// no model server. Swap it for a real `ModelNodePort` without touching the
// graph.

import { types as nodeTypes } from "node:util";

import type { ArtifactEnvelope } from "../contracts/artifact.js";
import {
  UNAVAILABLE_USAGE_FLOOR,
  USAGE_RECEIPT_BOUNDS,
  USAGE_RECEIPT_SCHEMA_VERSION,
  type UsageReceipt
} from "../contracts/usage-receipt.js";
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

/**
 * A `ModelNodePort` that answers `rules[context.nodeId]` and attaches an
 * `unavailableUsageReceipt`. A string rule is the outcome; an object rule is
 * `{ outcome, outputArtifact? }`; a function rule receives the validated
 * input and the turn context and returns either. A node without a rule fails
 * terminally with `immutable_configuration_rejected`.
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
          new Error(`fake model has no rule for node ${String(nodeId)}`)
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
