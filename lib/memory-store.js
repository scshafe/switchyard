// memory-store.ts — MemoryPipelineStore: a COMPLETE in-memory PipelineStore
// for hermetic tests (and a behavioral reference for host adapters, e.g. the
// inbox PG adapter over its PipelineWorkerRepository surface).
//
// It ENFORCES the port invariants, not just the happy path:
// - append-only evidence: definitions/runs/items/shards/finalizations/
//   executions/attempts/results/dead-letters/outbox/artifacts are never
//   updated or deleted — ONLY lease rows mutate (heartbeat/replace/release);
// - token fencing: every claim-scoped operation re-checks the lease and
//   throws the typed ShardLeaseLostError / WorkLeaseLostError on a missing,
//   expired, or foreign-token lease (inbox sql/postgres/009+012 semantics);
// - atomicity: every method validates COMPLETELY before its first mutation and
//   then mutates synchronously (no awaits in between), so a rejection appends
//   nothing — in particular persistStageSuccess/persistStageFailure outbox
//   events are all-or-nothing with their attempt evidence (the transactional
//   outbox);
// - exactly-once: results, dead letters, and finalizations are append-once per
//   key; duplicate successes return created:false without re-appending events.
//
// Time is injectable (`now` option) and every lease-touching call accepts an
// explicit `at` — the crash-reclaim tests expire leases by advancing time, not
// by sleeping.
//
// STANDALONE: node:crypto + relative imports only (no npm deps, no zod, no pg).
import { randomUUID } from "node:crypto";
import { digest } from "./contracts/digest.js";
import { validateArtifactEnvelope } from "./contracts/artifact.js";
import { validateCompiledPipeline } from "./compile.js";
import { validatePipelineDefinition } from "./definition.js";
import { validatePipelineShardReasonCode } from "./execute/control.js";
import { assertEvidenceDigest, assertEvidenceString, deepFrozenClone } from "./internal/evidence.js";
import { ShardLeaseLostError, WorkLeaseLostError, outboxEventDigest } from "./store.js";
const SHARD_LEASE_PREFIX = "shard:";
function itemKey(runId, itemId) {
    return `${runId}\0${itemId}`;
}
function artifactKey(contractId, digestHex) {
    return `${contractId}\0${digestHex}`;
}
function assertNonEmptyString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label}: must be a non-empty string`);
    }
    return value;
}
function assertPositiveIntNumber(value, label) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error(`${label}: must be a positive integer`);
    }
    return value;
}
function parseInstant(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label}: must be an ISO timestamp string`);
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed))
        throw new Error(`${label}: must be an ISO timestamp (got ${JSON.stringify(value)})`);
    return parsed;
}
function assertAttemptWindow(startedAt, finishedAt, label) {
    const startedAtMs = parseInstant(startedAt, `${label}: startedAt`);
    const finishedAtMs = parseInstant(finishedAt, `${label}: finishedAt`);
    if (finishedAtMs < startedAtMs) {
        throw new Error(`${label}: finishedAt must be at or after startedAt`);
    }
}
function clone(value) {
    return value === undefined ? value : structuredClone(value);
}
export class MemoryPipelineStore {
    #now;
    #definitions = new Map();
    #runs = new Map();
    #items = new Map();
    #shards = new Map();
    #shardOutcomes = new Map();
    /** The ONLY mutable state (shard claims under "shard:<id>" + auxiliary keys). */
    #leases = new Map();
    #executions = new Map();
    #results = new Map();
    #deadLetters = new Map();
    #outbox = [];
    #outboxDedupeKeys = new Set();
    #artifacts = new Map();
    /** runId\0itemId → terminal error code (first terminalization wins). */
    #terminalItems = new Map();
    /** runId\0itemId → nodeIds with a persisted success. */
    #succeededNodes = new Map();
    #shardCounter = 0;
    constructor(options = {}) {
        this.#now = options.now ?? (() => new Date());
    }
    // ── Definitions ─────────────────────────────────────────────────────────
    async publishDefinition(definitionRaw) {
        definitionRaw = deepFrozenClone(definitionRaw, "publishDefinition input");
        const definition = validatePipelineDefinition(definitionRaw);
        const key = `${definition.pipelineId}\0${definition.version}`;
        const existing = this.#definitions.get(key);
        if (existing) {
            if (existing.definitionDigest !== definition.definitionDigest) {
                throw new Error(`publishDefinition: ${definition.pipelineId}@${definition.version} is already published with digest ${existing.definitionDigest}; republish with digest ${definition.definitionDigest} rejected (append-only)`);
            }
            return; // idempotent republish of the identical sealed definition
        }
        this.#definitions.set(key, clone(definition));
    }
    async loadDefinition(pipelineId, version) {
        return clone(this.#definitions.get(`${pipelineId}\0${version}`));
    }
    // ── Runs ────────────────────────────────────────────────────────────────
    async createRun(input) {
        // Capture every caller-owned byte descriptor-first before validation.
        // This prevents getters or post-validation mutation from changing the
        // input whose digest/topology was admitted into append-only evidence.
        input = deepFrozenClone(input, "createRun input");
        const runId = assertNonEmptyString(input.run?.runId, "createRun: run.runId");
        if (this.#runs.has(runId))
            throw new Error(`createRun: run ${runId} already exists (append-only)`);
        const compiled = validateCompiledPipeline(input.run.compiled);
        const createdAt = assertNonEmptyString(input.run.createdAt, "createRun: run.createdAt");
        parseInstant(createdAt, "createRun: run.createdAt");
        if (!Array.isArray(input.items) || input.items.length < 1) {
            throw new Error("createRun: items must be a non-empty array");
        }
        const items = new Map();
        for (const [index, item] of input.items.entries()) {
            const itemId = assertNonEmptyString(item?.itemId, `createRun: items[${index}].itemId`);
            if (items.has(itemId))
                throw new Error(`createRun: duplicate itemId ${itemId}`);
            const ordinal = assertPositiveIntNumber(item.ordinal, `createRun: items[${index}].ordinal`);
            const inputDigest = assertNonEmptyString(item.inputDigest, `createRun: items[${index}].inputDigest`);
            const computed = digest(item.input);
            if (inputDigest !== computed) {
                throw new Error(`createRun: items[${index}] (${itemId}) inputDigest ${inputDigest} does not match digest(input) ${computed}`);
            }
            items.set(itemId, { itemId, ordinal, input: clone(item.input), inputDigest });
        }
        const ordinals = new Set([...items.values()].map((item) => item.ordinal));
        if (ordinals.size !== items.size || Math.max(...ordinals) !== items.size || Math.min(...ordinals) !== 1) {
            throw new Error("createRun: item ordinals must be exactly 1..n with no gaps or duplicates");
        }
        if (!Array.isArray(input.shards) || input.shards.length < 1) {
            throw new Error("createRun: shards must be a non-empty array");
        }
        const shardRows = [];
        const covered = new Set();
        for (const [index, shard] of input.shards.entries()) {
            const shardId = assertNonEmptyString(shard?.shardId, `createRun: shards[${index}].shardId`);
            if (this.#shards.has(shardId) || shardRows.some((row) => row.shardId === shardId)) {
                throw new Error(`createRun: shard ${shardId} already exists (shard ids are global)`);
            }
            if (!Array.isArray(shard.itemIds) || shard.itemIds.length < 1) {
                throw new Error(`createRun: shards[${index}] (${shardId}) must list at least one member itemId`);
            }
            for (const memberId of shard.itemIds) {
                if (!items.has(memberId))
                    throw new Error(`createRun: shard ${shardId} references unknown item ${memberId}`);
                if (covered.has(memberId))
                    throw new Error(`createRun: item ${memberId} appears in more than one shard`);
                covered.add(memberId);
            }
            shardRows.push({ shardId, runId, itemIds: [...shard.itemIds], createdOrder: this.#shardCounter + index });
        }
        if (covered.size !== items.size) {
            const missing = [...items.keys()].filter((id) => !covered.has(id));
            throw new Error(`createRun: shards must partition the items exactly — unsharded item(s): ${missing.join(", ")}`);
        }
        // All validation passed — mutate atomically (no awaits from here).
        this.#runs.set(runId, { runId, compiled, createdAt, configuration: clone(input.run.configuration) });
        this.#items.set(runId, items);
        for (const row of shardRows)
            this.#shards.set(row.shardId, row);
        this.#shardCounter += shardRows.length;
    }
    // ── Shard claim / lease lifecycle ───────────────────────────────────────
    async claimNextShard(input) {
        input = deepFrozenClone(input, "claimNextShard input");
        const leaseOwner = assertNonEmptyString(input.leaseOwner, "claimNextShard: leaseOwner");
        const leaseDurationMs = assertPositiveIntNumber(input.leaseDurationMs, "claimNextShard: leaseDurationMs");
        if ((input.runId === undefined) !== (input.shardId === undefined)) {
            throw new Error("claimNextShard: an exact claim requires both runId and shardId (promoted pairing rule)");
        }
        const at = input.at ?? this.#now().toISOString();
        const atMs = parseInstant(at, "claimNextShard: at");
        const candidates = [...this.#shards.values()]
            .filter((shard) => (input.shardId === undefined ? true : shard.shardId === input.shardId && shard.runId === input.runId))
            .sort((left, right) => left.createdOrder - right.createdOrder);
        for (const shard of candidates) {
            if (this.#hasConclusiveOutcome(shard.shardId))
                continue;
            const leaseKey = SHARD_LEASE_PREFIX + shard.shardId;
            const lease = this.#leases.get(leaseKey);
            if (lease && parseInstant(lease.expiresAt, "lease.expiresAt") > atMs)
                continue; // live claim — contended
            // Expired (or absent) lease: replace it — crash reclaim. Only the lease mutates.
            const leaseToken = randomUUID();
            const expiresAt = new Date(atMs + leaseDurationMs).toISOString();
            this.#leases.set(leaseKey, { leaseOwner, leaseToken, acquiredAt: at, heartbeatAt: at, expiresAt });
            const run = this.#runs.get(shard.runId);
            const items = this.#items.get(shard.runId);
            return {
                runId: shard.runId,
                shardId: shard.shardId,
                leaseOwner,
                leaseToken,
                acquiredAt: at,
                expiresAt,
                compiled: clone(run.compiled),
                items: shard.itemIds.map((memberId) => {
                    const item = items.get(memberId);
                    return { itemId: item.itemId, ordinal: item.ordinal, input: clone(item.input), inputDigest: item.inputDigest };
                })
            };
        }
        return undefined;
    }
    async heartbeatShard(input) {
        input = deepFrozenClone(input, "heartbeatShard input");
        const at = input.at ?? this.#now().toISOString();
        const lease = this.#fencedShardLease(input.shardId, input.leaseToken, at);
        const extendByMs = assertPositiveIntNumber(input.extendByMs, "heartbeatShard: extendByMs");
        const atMs = parseInstant(at, "heartbeatShard: at");
        if (atMs < parseInstant(lease.acquiredAt, "heartbeatShard: acquiredAt")
            || atMs < parseInstant(lease.heartbeatAt, "heartbeatShard: prior heartbeatAt")) {
            throw new Error("heartbeatShard: at must be at or after acquiredAt and the prior heartbeatAt");
        }
        const expiresAt = new Date(atMs + extendByMs).toISOString();
        // Compute every fallible value before mutating the lease atomically.
        lease.heartbeatAt = at;
        lease.expiresAt = expiresAt;
    }
    async completeShard(input) {
        input = deepFrozenClone(input, "completeShard input");
        const at = input.at ?? this.#now().toISOString();
        this.#fencedShardLease(input.shardId, input.leaseToken, at);
        const shard = this.#shards.get(input.shardId);
        const run = this.#runs.get(shard.runId);
        const allNodeIds = run.compiled.nodes.map((node) => node.nodeId);
        let completedItemCount = 0;
        let terminalItemCount = 0;
        const unresolved = [];
        for (const memberId of shard.itemIds) {
            const key = itemKey(shard.runId, memberId);
            if (this.#terminalItems.has(key)) {
                terminalItemCount += 1;
                continue;
            }
            const succeeded = this.#succeededNodes.get(key);
            if (succeeded && allNodeIds.every((nodeId) => succeeded.has(nodeId))) {
                completedItemCount += 1;
            }
            else {
                unresolved.push(memberId);
            }
        }
        if (unresolved.length > 0) {
            throw new Error(`completeShard: shard ${input.shardId} has unresolved member item(s) ${unresolved.join(", ")} — every member must be completed or terminal before finalization`);
        }
        const finalization = {
            status: terminalItemCount === 0 ? "completed" : "partial",
            itemCount: shard.itemIds.length,
            completedItemCount,
            terminalItemCount
        };
        this.#appendShardOutcome(input.shardId, { kind: finalization.status, ...finalization, at });
        this.#leases.delete(SHARD_LEASE_PREFIX + input.shardId); // release — leases are the only mutable state
        return finalization;
    }
    async failShard(input) {
        input = deepFrozenClone(input, "failShard input");
        const at = input.at ?? this.#now().toISOString();
        this.#fencedShardLease(input.shardId, input.leaseToken, at);
        if (typeof input.retryable !== "boolean")
            throw new Error("failShard: retryable must be a boolean");
        const errorCode = assertNonEmptyString(input.errorCode, "failShard: errorCode");
        this.#appendShardOutcome(input.shardId, { kind: "failed", retryable: input.retryable, errorCode, at });
        this.#leases.delete(SHARD_LEASE_PREFIX + input.shardId);
    }
    async deferShard(input) {
        input = deepFrozenClone(input, "deferShard input");
        const at = input.at ?? this.#now().toISOString();
        this.#fencedShardLease(input.shardId, input.leaseToken, at);
        const reasonCode = validatePipelineShardReasonCode(input.reasonCode, "deferShard: reasonCode");
        this.#appendShardOutcome(input.shardId, {
            kind: "deferred",
            reasonCode,
            at
        });
        this.#leases.delete(SHARD_LEASE_PREFIX + input.shardId);
    }
    async cancelShard(input) {
        input = deepFrozenClone(input, "cancelShard input");
        const at = input.at ?? this.#now().toISOString();
        this.#fencedShardLease(input.shardId, input.leaseToken, at);
        const reasonCode = validatePipelineShardReasonCode(input.reasonCode, "cancelShard: reasonCode");
        this.#appendShardOutcome(input.shardId, {
            kind: "cancelled",
            reasonCode,
            at
        });
        this.#leases.delete(SHARD_LEASE_PREFIX + input.shardId);
    }
    // ── Stage execution ─────────────────────────────────────────────────────
    async prepareStageExecution(input) {
        input = deepFrozenClone(input, "prepareStageExecution input");
        const at = this.#now().toISOString();
        this.#fencedShardLease(input.shardId, input.leaseToken, at);
        const shard = this.#shards.get(input.shardId);
        if (shard.runId !== input.runId) {
            throw new Error(`prepareStageExecution: shard ${input.shardId} belongs to run ${shard.runId}, not ${input.runId}`);
        }
        if (!shard.itemIds.includes(input.itemId)) {
            throw new Error(`prepareStageExecution: item ${input.itemId} is not a member of shard ${input.shardId}`);
        }
        const key = assertEvidenceDigest(input.idempotencyKey, "prepareStageExecution: idempotencyKey");
        const run = this.#runs.get(input.runId);
        const compiledNode = run.compiled.nodes.find((node) => node.nodeId === input.nodeId);
        if (compiledNode === undefined
            || compiledNode.stage.id !== input.stage.id
            || compiledNode.stage.version !== input.stage.version) {
            throw new Error(`prepareStageExecution: node/stage identity ${input.nodeId}:${input.stage.id}@${input.stage.version} is not present in run ${input.runId} compiled digest ${run.compiled.compiledDigest}`);
        }
        const expectedInputContract = compiledNode.inputs.length === 1
            ? compiledNode.inputs[0].contract
            : "pipeline-node-input.v1";
        if (input.inputContract !== expectedInputContract) {
            throw new Error(`prepareStageExecution: inputContract ${input.inputContract} does not match compiled node ${input.nodeId} input contract ${expectedInputContract}`);
        }
        const computed = digest(input.input);
        if (input.inputDigest !== computed) {
            throw new Error(`prepareStageExecution: inputDigest ${input.inputDigest} does not match digest(input) ${computed} (node ${input.nodeId})`);
        }
        let execution = this.#executions.get(key);
        if (execution) {
            this.#assertExecutionIdentity("prepareStageExecution", execution, {
                runId: input.runId,
                shardId: input.shardId,
                itemId: input.itemId,
                nodeId: input.nodeId,
                stage: input.stage,
                inputContract: input.inputContract,
                inputDigest: input.inputDigest,
                definitionDigest: run.compiled.pipeline.digest,
                compiledDigest: run.compiled.compiledDigest
            });
        }
        const cached = this.#results.get(key);
        if (cached)
            return { disposition: "cached", output: clone(cached.output), outputDigest: cached.outputDigest };
        const deadLetter = this.#deadLetters.get(key);
        if (deadLetter) {
            return {
                disposition: "terminal",
                errorCode: deadLetter.error.code,
                scope: "item"
            };
        }
        if (execution) {
            const terminalAttempt = execution.attempts.find((attempt) => attempt.terminal === true);
            if (terminalAttempt) {
                return {
                    disposition: "terminal",
                    errorCode: terminalAttempt.errorCode ?? "terminal_failure",
                    scope: terminalAttempt.scope ?? "item"
                };
            }
        }
        else {
            execution = {
                executionId: randomUUID(),
                runId: input.runId,
                shardId: input.shardId,
                itemId: input.itemId,
                nodeId: input.nodeId,
                stage: { id: input.stage.id, version: input.stage.version },
                definitionDigest: run.compiled.pipeline.digest,
                compiledDigest: run.compiled.compiledDigest,
                inputContract: input.inputContract,
                inputDigest: input.inputDigest,
                attempts: []
            };
            this.#executions.set(key, execution);
        }
        const previousAttempt = execution.attempts.at(-1);
        const previousFailure = previousAttempt?.status === "failed"
            && previousAttempt.errorCode !== undefined
            && previousAttempt.scope !== undefined
            ? {
                errorCode: previousAttempt.errorCode,
                scope: previousAttempt.scope
            }
            : undefined;
        return {
            disposition: "reserved",
            executionId: execution.executionId,
            attempt: execution.attempts.length + 1,
            ...(previousFailure === undefined ? {} : { previousFailure })
        };
    }
    async persistStageSuccess(input, outboxEvents = []) {
        input = deepFrozenClone(input, "persistStageSuccess input");
        const outboxBatch = this.#snapshotOutboxEvents("persistStageSuccess", outboxEvents);
        const at = this.#now().toISOString();
        this.#fencedShardLease(input.shardId, input.leaseToken, at);
        const key = assertEvidenceDigest(input.idempotencyKey, "persistStageSuccess: idempotencyKey");
        assertAttemptWindow(input.startedAt, input.finishedAt, "persistStageSuccess");
        const execution = this.#requireExecution(key, input.executionId, "persistStageSuccess");
        this.#assertExecutionIdentity("persistStageSuccess", execution, input);
        const run = this.#runs.get(input.runId);
        const compiledNode = run.compiled.nodes.find((node) => node.nodeId === input.nodeId);
        if (compiledNode === undefined
            || input.outputContract !== compiledNode.outputContract) {
            throw new Error(`persistStageSuccess: outputContract ${input.outputContract} does not match compiled node ${input.nodeId}`);
        }
        const computed = digest(input.output);
        if (input.outputDigest !== computed) {
            throw new Error(`persistStageSuccess: outputDigest ${input.outputDigest} does not match digest(output) ${computed}`);
        }
        const existing = this.#results.get(key);
        if (existing) {
            // Exactly-once: the first-created result won; append NOTHING (no attempt
            // row, no outbox events).
            const committedOutboxEventDigests = this.#outbox
                .filter((event) => event.executionId === existing.executionId
                && event.attempt === existing.attempt)
                .map((event) => outboxEventDigest({
                eventType: event.eventType,
                payload: event.payload,
                ...(event.dedupeKey === undefined ? {} : { dedupeKey: event.dedupeKey })
            }));
            return {
                output: clone(existing.output),
                outputDigest: existing.outputDigest,
                created: false,
                committedOutboxEventDigests
            };
        }
        if (this.#deadLetters.has(key)) {
            throw new Error(`persistStageSuccess: idempotency key ${key} is already dead-lettered (append-only evidence)`);
        }
        if (input.attempt !== execution.attempts.length + 1) {
            throw new Error(`persistStageSuccess: attempt ${input.attempt} is not the next attempt for key ${key} (expected ${execution.attempts.length + 1} — re-prepare after a crash or fence)`);
        }
        const events = this.#validateOutboxEvents("persistStageSuccess", input, outboxBatch, at);
        // All validation passed — mutate atomically (result + attempt + outbox +
        // content-addressed output artifact appear together or not at all).
        execution.attempts.push({
            attempt: input.attempt,
            status: "succeeded",
            startedAt: input.startedAt,
            finishedAt: input.finishedAt
        });
        this.#results.set(key, {
            executionId: input.executionId,
            attempt: input.attempt,
            idempotencyKey: key,
            runId: input.runId,
            itemId: input.itemId,
            nodeId: input.nodeId,
            outputContract: input.outputContract,
            output: clone(input.output),
            outputDigest: input.outputDigest,
            recordedAt: at
        });
        const succeededKey = itemKey(input.runId, input.itemId);
        const succeeded = this.#succeededNodes.get(succeededKey) ?? new Set();
        succeeded.add(input.nodeId);
        this.#succeededNodes.set(succeededKey, succeeded);
        for (const event of events) {
            this.#outbox.push(event);
            if (event.dedupeKey !== undefined)
                this.#outboxDedupeKeys.add(event.dedupeKey);
        }
        const artifactId = artifactKey(input.outputContract, input.outputDigest);
        if (!this.#artifacts.has(artifactId)) {
            this.#artifacts.set(artifactId, {
                contractId: input.outputContract,
                digest: input.outputDigest,
                payload: clone(input.output)
            });
        }
        return { output: clone(input.output), outputDigest: input.outputDigest, created: true };
    }
    async persistStageFailure(input, outboxEvents = []) {
        input = deepFrozenClone(input, "persistStageFailure input");
        const outboxBatch = this.#snapshotOutboxEvents("persistStageFailure", outboxEvents);
        const at = this.#now().toISOString();
        this.#fencedShardLease(input.shardId, input.leaseToken, at);
        const key = assertEvidenceDigest(input.idempotencyKey, "persistStageFailure: idempotencyKey");
        assertAttemptWindow(input.startedAt, input.finishedAt, "persistStageFailure");
        const execution = this.#requireExecution(key, input.executionId, "persistStageFailure");
        this.#assertExecutionIdentity("persistStageFailure", execution, input);
        if (this.#results.has(key)) {
            throw new Error(`persistStageFailure: idempotency key ${key} already has a persisted success (append-only evidence)`);
        }
        if (input.attempt !== execution.attempts.length + 1) {
            throw new Error(`persistStageFailure: attempt ${input.attempt} is not the next attempt for key ${key} (expected ${execution.attempts.length + 1})`);
        }
        const errorCode = assertNonEmptyString(input.errorCode, "persistStageFailure: errorCode");
        // Treat the public TypeScript union as untrusted at runtime too: JavaScript
        // hosts and deserialized calls can still omit or contradict its fields.
        const raw = input;
        if (raw.scope !== "item" && raw.scope !== "shard") {
            throw new Error('persistStageFailure: scope must be "item" or "shard"');
        }
        if (typeof raw.retryable !== "boolean") {
            throw new Error("persistStageFailure: retryable must be a boolean");
        }
        if (typeof raw.terminal !== "boolean") {
            throw new Error("persistStageFailure: terminal must be a boolean");
        }
        if (raw.terminal && raw.deadLetter === undefined) {
            if (raw.scope === "item") {
                throw new Error("persistStageFailure: an item-terminal failure requires its atomic dead letter");
            }
        }
        let terminalDeadLetter;
        if (raw.deadLetter !== undefined) {
            if (!raw.terminal || raw.scope !== "item") {
                throw new Error("persistStageFailure: deadLetter may only ride an ITEM-terminal failure");
            }
            terminalDeadLetter = deepFrozenClone(raw.deadLetter, "persistStageFailure.deadLetter");
            if (terminalDeadLetter.idempotencyKey !== key) {
                throw new Error(`persistStageFailure: deadLetter.idempotencyKey ${terminalDeadLetter.idempotencyKey} does not match the failure's key ${key}`);
            }
            if (terminalDeadLetter.runId !== input.runId
                || terminalDeadLetter.itemId !== input.itemId
                || terminalDeadLetter.nodeId !== input.nodeId
                || terminalDeadLetter.stage.id !== execution.stage.id
                || terminalDeadLetter.stage.version !== execution.stage.version
                || terminalDeadLetter.attempts !== input.attempt
                || terminalDeadLetter.error.code !== input.errorCode
                || input.errorMessage === undefined
                || terminalDeadLetter.error.message !== input.errorMessage
                || terminalDeadLetter.createdAt !== input.finishedAt
                || !("input" in terminalDeadLetter)
                || digest(terminalDeadLetter.input) !== execution.inputDigest) {
                throw new Error("persistStageFailure: deadLetter run/item/node/stage/attempt/error/input/createdAt must exactly match the outer failure and prepared execution");
            }
            if (this.#deadLetters.has(key)) {
                throw new Error(`persistStageFailure: idempotency key ${key} is already dead-lettered (append-only evidence)`);
            }
        }
        const events = this.#validateOutboxEvents("persistStageFailure", input, outboxBatch, at);
        // Mutate atomically: failed attempt (+ terminal marker + dead letter +
        // outbox events).
        execution.attempts.push({
            attempt: input.attempt,
            status: "failed",
            startedAt: input.startedAt,
            finishedAt: input.finishedAt,
            errorCode,
            ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
            retryable: input.retryable,
            scope: input.scope,
            terminal: input.terminal
        });
        if (input.terminal && input.scope === "item") {
            const terminalKey = itemKey(input.runId, input.itemId);
            if (!this.#terminalItems.has(terminalKey))
                this.#terminalItems.set(terminalKey, errorCode);
        }
        if (terminalDeadLetter !== undefined) {
            this.#deadLetters.set(key, { deadLetterId: randomUUID(), ...clone(terminalDeadLetter) });
        }
        for (const event of events) {
            this.#outbox.push(event);
            if (event.dedupeKey !== undefined)
                this.#outboxDedupeKeys.add(event.dedupeKey);
        }
    }
    async recordDeadLetter(input) {
        input = deepFrozenClone(input, "recordDeadLetter input");
        if (!Object.prototype.hasOwnProperty.call(input, "input")) {
            throw new Error("recordDeadLetter: input is required");
        }
        const at = this.#now().toISOString();
        this.#fencedShardLease(input.shardId, input.leaseToken, at);
        const shard = this.#shards.get(input.shardId);
        if (shard.runId !== input.runId) {
            throw new Error(`recordDeadLetter: shard ${input.shardId} belongs to run ${shard.runId}, not ${input.runId}`);
        }
        if (!shard.itemIds.includes(input.itemId)) {
            throw new Error(`recordDeadLetter: item ${input.itemId} is not a member of shard ${input.shardId}`);
        }
        const deadLetter = {
            runId: input.runId,
            itemId: input.itemId,
            nodeId: input.nodeId,
            stage: input.stage,
            idempotencyKey: input.idempotencyKey,
            input: input.input,
            error: input.error,
            attempts: input.attempts,
            createdAt: input.createdAt
        };
        const key = assertEvidenceDigest(deadLetter.idempotencyKey, "recordDeadLetter: idempotencyKey");
        assertEvidenceString(deadLetter.error.code, "recordDeadLetter: error.code");
        assertEvidenceString(deadLetter.error.message, "recordDeadLetter: error.message");
        const createdAtMs = parseInstant(deadLetter.createdAt, "recordDeadLetter: createdAt");
        const execution = this.#executions.get(key);
        if (!execution) {
            throw new Error(`recordDeadLetter: idempotency key ${key} has no prepared stage execution`);
        }
        if (execution.runId !== deadLetter.runId
            || execution.shardId !== input.shardId
            || execution.itemId !== deadLetter.itemId
            || execution.nodeId !== deadLetter.nodeId
            || execution.stage.id !== deadLetter.stage.id
            || execution.stage.version !== deadLetter.stage.version) {
            throw new Error("recordDeadLetter: evidence identity differs from its prepared stage execution");
        }
        const run = this.#runs.get(input.runId);
        if (execution.definitionDigest !== run.compiled.pipeline.digest
            || execution.compiledDigest !== run.compiled.compiledDigest) {
            throw new Error("recordDeadLetter: definition/compiled identity differs from its prepared stage execution");
        }
        if (this.#results.has(key)) {
            throw new Error(`recordDeadLetter: idempotency key ${key} already has a persisted success`);
        }
        if (!Number.isInteger(deadLetter.attempts)
            || deadLetter.attempts < 1) {
            throw new Error("recordDeadLetter: attempts must identify a positive prior attempt");
        }
        const latestAttempt = execution.attempts.at(-1);
        if (latestAttempt?.status !== "failed"
            || latestAttempt.attempt !== deadLetter.attempts
            || latestAttempt.scope !== "item") {
            throw new Error("recordDeadLetter: evidence must reference the exact latest item failure");
        }
        const latestFinishedAtMs = parseInstant(latestAttempt.finishedAt, "recordDeadLetter: latest attempt finishedAt");
        if (createdAtMs < latestFinishedAtMs) {
            throw new Error("recordDeadLetter: createdAt must be at or after the referenced attempt finishedAt");
        }
        if (digest(deadLetter.input) !== execution.inputDigest) {
            throw new Error("recordDeadLetter: input differs from its prepared stage execution");
        }
        const existing = this.#deadLetters.get(key);
        if (existing !== undefined) {
            const { deadLetterId: _deadLetterId, createdAt: _existingCreatedAt, ...existingEvidence } = existing;
            const { createdAt: _replayCreatedAt, ...replayEvidence } = deadLetter;
            if (digest(existingEvidence) !== digest(replayEvidence)) {
                throw new Error("recordDeadLetter: duplicate call conflicts with the append-once dead-letter evidence");
            }
            // createdAt is append-once evidence owned by the first successful
            // transaction. A crash replay legitimately observes a later clock and
            // must reuse the stored timestamp instead of conflicting or rewriting.
            return { created: false };
        }
        if (latestAttempt.terminal !== false) {
            throw new Error("recordDeadLetter: new evidence must reference the exact latest nonterminal item failure");
        }
        this.#deadLetters.set(key, {
            deadLetterId: randomUUID(),
            ...clone(deadLetter)
        });
        const terminalKey = itemKey(deadLetter.runId, deadLetter.itemId);
        if (!this.#terminalItems.has(terminalKey)) {
            this.#terminalItems.set(terminalKey, deadLetter.error.code);
        }
        return { created: true };
    }
    // ── Artifacts ───────────────────────────────────────────────────────────
    async putArtifact(envelopeRaw) {
        envelopeRaw = deepFrozenClone(envelopeRaw, "putArtifact input");
        const envelope = validateArtifactEnvelope(envelopeRaw); // seal verified (digest recompute)
        const key = artifactKey(envelope.contractId, envelope.digest);
        if (!this.#artifacts.has(key))
            this.#artifacts.set(key, clone(envelope));
        const ref = { contractId: envelope.contractId, digest: envelope.digest };
        if (envelope.bytes !== undefined)
            ref.bytes = envelope.bytes;
        return ref;
    }
    async getArtifact(ref) {
        ref = deepFrozenClone(ref, "getArtifact input");
        return clone(this.#artifacts.get(artifactKey(ref.contractId, ref.digest)));
    }
    // ── Auxiliary work leases ───────────────────────────────────────────────
    async acquireLease(input) {
        input = deepFrozenClone(input, "acquireLease input");
        const leaseKey = assertNonEmptyString(input.leaseKey, "acquireLease: leaseKey");
        if (leaseKey.startsWith(SHARD_LEASE_PREFIX)) {
            throw new Error(`acquireLease: the "${SHARD_LEASE_PREFIX}" key prefix is reserved for shard claims (claimNextShard)`);
        }
        const leaseOwner = assertNonEmptyString(input.leaseOwner, "acquireLease: leaseOwner");
        const leaseDurationMs = assertPositiveIntNumber(input.leaseDurationMs, "acquireLease: leaseDurationMs");
        const at = input.at ?? this.#now().toISOString();
        const atMs = parseInstant(at, "acquireLease: at");
        const existing = this.#leases.get(leaseKey);
        if (existing && parseInstant(existing.expiresAt, "lease.expiresAt") > atMs)
            return undefined; // contended
        const lease = {
            leaseOwner,
            leaseToken: randomUUID(),
            acquiredAt: at,
            heartbeatAt: at,
            expiresAt: new Date(atMs + leaseDurationMs).toISOString()
        };
        this.#leases.set(leaseKey, lease);
        return { leaseKey, leaseOwner, leaseToken: lease.leaseToken, acquiredAt: at, expiresAt: lease.expiresAt };
    }
    async heartbeatLease(input) {
        input = deepFrozenClone(input, "heartbeatLease input");
        const at = input.at ?? this.#now().toISOString();
        const atMs = parseInstant(at, "heartbeatLease: at");
        const extendByMs = assertPositiveIntNumber(input.extendByMs, "heartbeatLease: extendByMs");
        const lease = this.#leases.get(input.leaseKey);
        if (!lease || lease.leaseToken !== input.leaseToken || parseInstant(lease.expiresAt, "lease.expiresAt") <= atMs) {
            throw new WorkLeaseLostError(input.leaseKey);
        }
        if (atMs < parseInstant(lease.acquiredAt, "heartbeatLease: acquiredAt")
            || atMs < parseInstant(lease.heartbeatAt, "heartbeatLease: prior heartbeatAt")) {
            throw new Error("heartbeatLease: at must be at or after acquiredAt and the prior heartbeatAt");
        }
        const expiresAt = new Date(atMs + extendByMs).toISOString();
        // Compute every fallible value before mutating the lease atomically.
        lease.heartbeatAt = at;
        lease.expiresAt = expiresAt;
    }
    async releaseLease(input) {
        input = deepFrozenClone(input, "releaseLease input");
        const lease = this.#leases.get(input.leaseKey);
        if (!lease)
            return; // already expired-and-replaced or released — a no-op
        if (lease.leaseToken !== input.leaseToken)
            throw new WorkLeaseLostError(input.leaseKey); // never release a foreign fence
        this.#leases.delete(input.leaseKey);
    }
    // ── Hermetic-test inspection (NOT part of the PipelineStore port) ───────
    get deadLetterRecords() {
        return [...this.#deadLetters.values()].map((record) => clone(record));
    }
    get outboxEventRecords() {
        return this.#outbox.map((event) => clone(event));
    }
    attemptsForKey(idempotencyKey) {
        return (this.#executions.get(idempotencyKey)?.attempts ?? []).map((attempt) => clone(attempt));
    }
    leaseSnapshot(leaseKey) {
        const lease = this.#leases.get(leaseKey);
        return lease === undefined ? undefined : { leaseKey, ...lease };
    }
    shardLeaseSnapshot(shardId) {
        return this.leaseSnapshot(SHARD_LEASE_PREFIX + shardId);
    }
    /** Complete JSON-safe state for hermetic atomicity assertions (not a port API). */
    inspectionSnapshot() {
        return clone({
            definitions: [...this.#definitions.entries()],
            runs: [...this.#runs.entries()],
            items: [...this.#items.entries()].map(([runId, items]) => [
                runId,
                [...items.entries()]
            ]),
            shards: [...this.#shards.entries()],
            shardOutcomes: [...this.#shardOutcomes.entries()],
            leases: [...this.#leases.entries()],
            executions: [...this.#executions.entries()],
            results: [...this.#results.entries()],
            deadLetters: [...this.#deadLetters.entries()],
            outbox: this.#outbox,
            outboxDedupeKeys: [...this.#outboxDedupeKeys],
            artifacts: [...this.#artifacts.entries()],
            terminalItems: [...this.#terminalItems.entries()],
            succeededNodes: [...this.#succeededNodes.entries()].map(([key, nodes]) => [key, [...nodes]]),
            shardCounter: this.#shardCounter
        });
    }
    // ── Internals ───────────────────────────────────────────────────────────
    #fencedShardLease(shardId, leaseToken, at) {
        if (!this.#shards.has(shardId))
            throw new ShardLeaseLostError(shardId);
        const lease = this.#leases.get(SHARD_LEASE_PREFIX + shardId);
        if (!lease ||
            lease.leaseToken !== leaseToken ||
            parseInstant(lease.expiresAt, "lease.expiresAt") <= parseInstant(at, "at")) {
            throw new ShardLeaseLostError(shardId); // missing, expired, or fenced
        }
        return lease;
    }
    #hasConclusiveOutcome(shardId) {
        const outcomes = this.#shardOutcomes.get(shardId) ?? [];
        return outcomes.some((outcome) => outcome.kind === "completed" || outcome.kind === "partial" || (outcome.kind === "failed" && outcome.retryable === false)
            || outcome.kind === "cancelled");
    }
    #appendShardOutcome(shardId, outcome) {
        const outcomes = this.#shardOutcomes.get(shardId) ?? [];
        const { status: _status, ...row } = outcome;
        outcomes.push(row);
        this.#shardOutcomes.set(shardId, outcomes);
    }
    #requireExecution(idempotencyKey, executionId, label) {
        const execution = this.#executions.get(idempotencyKey);
        if (!execution) {
            throw new Error(`${label}: no reserved execution for idempotency key ${idempotencyKey} — call prepareStageExecution first`);
        }
        if (execution.executionId !== executionId) {
            throw new Error(`${label}: executionId ${executionId} does not match the reservation ${execution.executionId} for key ${idempotencyKey}`);
        }
        return execution;
    }
    #assertExecutionIdentity(label, execution, input) {
        const run = this.#runs.get(input.runId);
        const definitionDigest = input.definitionDigest ?? run?.compiled.pipeline.digest;
        const compiledDigest = input.compiledDigest ?? run?.compiled.compiledDigest;
        if (execution.runId !== input.runId
            || execution.shardId !== input.shardId
            || execution.itemId !== input.itemId
            || execution.nodeId !== input.nodeId
            || definitionDigest !== execution.definitionDigest
            || compiledDigest !== execution.compiledDigest
            || (input.stage !== undefined
                && (execution.stage.id !== input.stage.id
                    || execution.stage.version !== input.stage.version))
            || (input.inputContract !== undefined
                && execution.inputContract !== input.inputContract)
            || (input.inputDigest !== undefined
                && execution.inputDigest !== input.inputDigest)) {
            throw new Error(`${label}: run/shard/item/node/stage/definition/compiled evidence identity differs from its prepared stage execution`);
        }
    }
    #snapshotOutboxEvents(label, outboxEvents) {
        const snapshot = deepFrozenClone(outboxEvents, `${label}: outboxEvents`);
        const allowedKeys = new Set(["eventType", "payload", "dedupeKey"]);
        return Object.freeze(snapshot.map((event, index) => {
            const eventLabel = `${label}: outboxEvents[${index}]`;
            for (const key of Object.keys(event)) {
                if (!allowedKeys.has(key)) {
                    throw new Error(`${eventLabel}: unknown property ${key}`);
                }
            }
            if (!Object.prototype.hasOwnProperty.call(event, "payload")) {
                throw new Error(`${eventLabel}.payload: required`);
            }
            const eventType = assertEvidenceString(event.eventType, `${eventLabel}.eventType`);
            const dedupeKey = event.dedupeKey === undefined
                ? undefined
                : assertEvidenceString(event.dedupeKey, `${eventLabel}.dedupeKey`);
            return Object.freeze({
                eventType,
                payload: event.payload,
                ...(dedupeKey === undefined ? {} : { dedupeKey })
            });
        }));
    }
    #validateOutboxEvents(label, input, outboxEvents, recordedAt) {
        const events = outboxEvents.map((event, index) => {
            const eventType = assertEvidenceString(event.eventType, `${label}: outboxEvents[${index}].eventType`);
            if (event.dedupeKey !== undefined
                && this.#outboxDedupeKeys.has(event.dedupeKey)) {
                throw new Error(`${label}: outbox dedupeKey ${event.dedupeKey} already recorded (rejecting the WHOLE persist — atomic outbox)`);
            }
            return {
                outboxEventId: randomUUID(),
                executionId: input.executionId,
                attempt: input.attempt,
                runId: input.runId,
                itemId: input.itemId,
                nodeId: input.nodeId,
                idempotencyKey: input.idempotencyKey,
                eventType,
                payload: clone(event.payload),
                ...(event.dedupeKey === undefined
                    ? {}
                    : { dedupeKey: event.dedupeKey }),
                recordedAt
            };
        });
        const duplicateDedupe = events
            .map((event) => event.dedupeKey)
            .filter((dedupeKey, index, all) => dedupeKey !== undefined && all.indexOf(dedupeKey) !== index);
        if (duplicateDedupe.length > 0) {
            throw new Error(`${label}: duplicate outbox dedupeKey within one persist: ${duplicateDedupe.join(", ")}`);
        }
        return events;
    }
}
