import { type UsageReceipt } from "../contracts/usage-receipt.js";
export declare const MAX_NODE_TURN_FAILURE_MESSAGE_LENGTH = 2000;
export declare function validateNodeTurnFailureMessage(value: unknown, label: string): string;
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
export declare function nodeTurnFailureDigest(input: NodeTurnFailureDigestInput): string;
export declare function nodeTurnSettlementDigest(input: NodeTurnSettlementDigestInput): string;
