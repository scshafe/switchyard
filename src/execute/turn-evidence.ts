// execute/turn-evidence.ts — canonical immutable seals shared by the v2
// runner and UnitStore adapters. Coordination lease tokens and completion
// recovery bytes are deliberately excluded from these evidence identities.

import { digest } from "../contracts/digest.js";
import { validateUsageReceipt, type UsageReceipt } from "../contracts/usage-receipt.js";
import {
  assertIdentifier,
  assertSafePositiveInt,
  assertSha256Hex
} from "../internal/guards.js";
import {
  captureCapabilityRecord,
  captureDenseArrayItems
} from "../internal/capability.js";
import { assertEvidenceString } from "../internal/evidence.js";
import { MAX_AGENT_TURN_USAGE_RECEIPTS } from "./ports.js";

const FAILURE_KEYS = [
  "queueId", "unitId", "nodeId", "attemptNumber", "attemptIndex", "idempotencyKey",
  "principalId", "startedAt", "failedAt", "errorCode", "errorMessage", "retryable",
  "terminal", "usage"
] as const;
const SETTLEMENT_KEYS = [
  "queueId", "unitId", "nodeId", "attemptNumber", "attemptIndex", "idempotencyKey",
  "principalId", "actorId", "startedAt", "settledAt", "completionDigest"
] as const;
const DateConstructor = Date;
const dateParse = Date.parse;
const dateToISOString = Date.prototype.toISOString;
export const MAX_NODE_TURN_FAILURE_MESSAGE_LENGTH = 2_000;

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

export function validateNodeTurnFailureMessage(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_NODE_TURN_FAILURE_MESSAGE_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(
      `${label} must be 1..${MAX_NODE_TURN_FAILURE_MESSAGE_LENGTH} characters without control characters`
    );
  }
  return value;
}

function assertCanonicalTimestamp(value: unknown, label: string): string {
  const epoch = typeof value === "string"
    ? Reflect.apply(dateParse, DateConstructor, [value])
    : Number.NaN;
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(epoch)
    || Reflect.apply(dateToISOString, new DateConstructor(epoch), []) !== value
  ) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

export interface NodeTurnFailureDigestInput {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly startedAt: string;
  readonly failedAt: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
  readonly terminal: boolean;
  readonly usage: readonly UsageReceipt[];
}

export interface NodeTurnSettlementDigestInput {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly actorId?: string;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly completionDigest: string;
}

export function nodeTurnFailureDigest(input: NodeTurnFailureDigestInput): string {
  const raw = captureCapabilityRecord(
    input,
    FAILURE_KEYS,
    FAILURE_KEYS,
    "node turn failure digest input"
  );
  const usageRaw = captureDenseArrayItems(
    raw.usage,
    "node turn failure digest input.usage",
    MAX_AGENT_TURN_USAGE_RECEIPTS
  );
  const usage = Object.freeze(usageRaw.map(validateUsageReceipt));
  return digest({
    queueId: assertEvidenceString(raw.queueId, "node turn failure digest input.queueId"),
    unitId: assertEvidenceString(raw.unitId, "node turn failure digest input.unitId"),
    nodeId: assertIdentifier(raw.nodeId, "node turn failure digest input.nodeId"),
    attemptNumber: assertSafePositiveInt(raw.attemptNumber, "node turn failure digest input.attemptNumber"),
    attemptIndex: assertSafePositiveInt(raw.attemptIndex, "node turn failure digest input.attemptIndex"),
    idempotencyKey: assertSha256Hex(raw.idempotencyKey, "node turn failure digest input.idempotencyKey"),
    principalId: assertIdentifier(raw.principalId, "node turn failure digest input.principalId"),
    startedAt: assertCanonicalTimestamp(raw.startedAt, "node turn failure digest input.startedAt"),
    failedAt: assertCanonicalTimestamp(raw.failedAt, "node turn failure digest input.failedAt"),
    errorCode: assertIdentifier(raw.errorCode, "node turn failure digest input.errorCode"),
    errorMessage: validateNodeTurnFailureMessage(
      raw.errorMessage,
      "node turn failure digest input.errorMessage"
    ),
    retryable: assertBoolean(raw.retryable, "node turn failure digest input.retryable"),
    terminal: assertBoolean(raw.terminal, "node turn failure digest input.terminal"),
    usage
  });
}

export function nodeTurnSettlementDigest(input: NodeTurnSettlementDigestInput): string {
  const raw = captureCapabilityRecord(
    input,
    SETTLEMENT_KEYS,
    SETTLEMENT_KEYS.filter((key) => key !== "actorId"),
    "node turn settlement digest input"
  );
  const actorId = Object.hasOwn(raw, "actorId")
    ? assertEvidenceString(raw.actorId, "node turn settlement digest input.actorId")
    : undefined;
  return digest({
    queueId: assertEvidenceString(raw.queueId, "node turn settlement digest input.queueId"),
    unitId: assertEvidenceString(raw.unitId, "node turn settlement digest input.unitId"),
    nodeId: assertIdentifier(raw.nodeId, "node turn settlement digest input.nodeId"),
    attemptNumber: assertSafePositiveInt(raw.attemptNumber, "node turn settlement digest input.attemptNumber"),
    attemptIndex: assertSafePositiveInt(raw.attemptIndex, "node turn settlement digest input.attemptIndex"),
    idempotencyKey: assertSha256Hex(raw.idempotencyKey, "node turn settlement digest input.idempotencyKey"),
    principalId: assertIdentifier(raw.principalId, "node turn settlement digest input.principalId"),
    ...(actorId === undefined ? {} : { actorId }),
    startedAt: assertCanonicalTimestamp(raw.startedAt, "node turn settlement digest input.startedAt"),
    settledAt: assertCanonicalTimestamp(raw.settledAt, "node turn settlement digest input.settledAt"),
    completionDigest: assertSha256Hex(raw.completionDigest, "node turn settlement digest input.completionDigest")
  });
}
