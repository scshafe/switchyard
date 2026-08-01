// execute/shard-runner.ts — execute ONE shard through a single shared node
// walk. runOneShard owns the legacy Pipeline claim/heartbeat/finalize/release
// lifecycle. runBoundShard accepts host-bound work + an opaque external fence,
// appends only stage evidence, and returns an outcome for host settlement.
// Both execute compiled nodes in array order per item (CompiledPipeline.nodes
// are already topologically ordered) and isolate per-item failures (a terminal
// item skips its downstream nodes while the other items continue).
//
// PROMOTED from inbox-pipeline/src/worker/service.ts runOneShotPipelineWorker
// (the claim-one-shard shape with idle outcome; option validation — attempt
// budget 1..10, heartbeat cadence below the lease duration, the exact
// runId+shardId pairing rule; the artifacts map + pipeline_input/node_output
// slot resolution; the missing-artifact LOUD rejection; the terminal-item
// `break` + `continue` isolation; runWithHeartbeat with single-flight
// heartbeats, deferred heartbeat-error surfacing, and timer.unref; failShard
// swallowing a lost lease; completed/partial finalization outcomes) — re-cut
// over the PipelineStore port + the B3 durable executor, which now owns the
// prepare/persist/retry/dead-letter cycle that service.ts inlined.
// CHANGES in the promotion:
//   - NodeInvoker PORT for the non-code kinds (model/agent/gate): B3 defines
//     the port and ships a fake; B4 (model bindings + receipts), B5 (gate
//     decision flows), and B6 (agent steps) implement it. Dispatch is on
//     compiled node kind; catalog.resolveExecutable remains the LOUD
//     parity lookup for EVERY kind before dispatch;
//   - heartbeatEveryMs floor lowered from the inbox 5000ms to 1ms so hermetic
//     tests can observe heartbeats; production hosts configure their own
//     floors (the everyMs < leaseDurationMs relationship is kept);
//   - the inbox email-specific admissions (provider registration, hydration
//     readiness, claim-topology snapshot checks) stay HOST concerns — the
//     engine-level equivalents are the sealed-compiled-pipeline revalidation
//     (validateCompiledPipeline on the claim) and the compile-time checks.
//
// STANDALONE: relative imports only (no npm deps, no zod, no pg).
import { types as nodeTypes } from "node:util";
import { validateCompiledPipeline } from "../compile.js";
import { StageCatalog } from "../catalog.js";
import { digest } from "../contracts/digest.js";
import { ExternalFenceRejectedError, EvidenceConflictError, BoundEvidencePersistenceError, ShardLeaseLostError } from "../store.js";
import { classifyStageFailure, executeBoundDurableStage, executeDurableStage, OutboxEvidenceNotCommittedError, PipelineStageError, StageEvidenceAssemblyError, StageResultConflictError } from "./durable-stage.js";
import { PipelineControlOutcomeError, PipelineShardCancelledError, PipelineShardDeferredError } from "./control.js";
function isInstanceOf(value, constructor) {
    try {
        if (value !== null
            && (typeof value === "object" || typeof value === "function")
            && nodeTypes.isProxy(value)) {
            return false;
        }
        return value instanceof constructor;
    }
    catch {
        return false;
    }
}
/**
 * The B3 FAKE invoker: identity by default (echoes the composed input — the
 * B2 "identity-only executables for non-code kinds" behavior), overridable
 * per stageId for tests. B4/B5/B6 replace it with real implementations.
 */
export function createFakeNodeInvoker(handlers = {}) {
    return {
        async invoke(invocation) {
            const handler = handlers[invocation.node.stage.id];
            return handler === undefined ? invocation.input : handler(invocation);
        }
    };
}
// ── Heartbeats (promoted runWithHeartbeat) ────────────────────────────────
/**
 * Run `operation` while heartbeating the shard lease every `everyMs`:
 * single-flight (a slow heartbeat is never overlapped), failures captured and
 * surfaced AFTER the operation (a lost lease fences the result even when the
 * work itself succeeded), timer unref'd so it never holds the process open.
 */
export async function runWithShardHeartbeat(input) {
    const fields = snapshotOptionRecord(input, HEARTBEAT_OPTION_KEYS, HEARTBEAT_OPTION_KEYS, "runWithShardHeartbeat input");
    const heartbeatShard = captureObjectMethod(fields.store, "heartbeatShard", "heartbeat store");
    const shardId = assertIdentityString(fields.shardId, "runWithShardHeartbeat shardId");
    const leaseToken = assertIdentityString(fields.leaseToken, "runWithShardHeartbeat leaseToken");
    const everyMs = fields.everyMs;
    const extendByMs = fields.extendByMs;
    if (!Number.isInteger(everyMs) || everyMs < 1) {
        throw new Error("runWithShardHeartbeat everyMs must be a positive integer");
    }
    if (!Number.isInteger(extendByMs) || extendByMs < 1) {
        throw new Error("runWithShardHeartbeat extendByMs must be a positive integer");
    }
    const now = fields.now;
    if (typeof now !== "function") {
        throw new Error("runWithShardHeartbeat now must be a function");
    }
    const operation = fields.operation;
    if (typeof operation !== "function") {
        throw new Error("runWithShardHeartbeat operation must be a function");
    }
    let heartbeatError;
    let heartbeatFailed = false;
    let heartbeatInFlight;
    const timer = setInterval(() => {
        if (heartbeatInFlight || heartbeatFailed)
            return;
        // Begin with a promise boundary so a synchronous host method, clock, or
        // request-construction failure is captured instead of escaping the timer
        // callback as an uncaught exception.
        heartbeatInFlight = Promise.resolve()
            .then(() => heartbeatShard({
            shardId,
            leaseToken,
            extendByMs: extendByMs,
            at: Date.prototype.toISOString.call(now())
        }))
            .catch((error) => {
            heartbeatFailed = true;
            heartbeatError = error;
        })
            .finally(() => {
            heartbeatInFlight = undefined;
        });
    }, everyMs);
    timer.unref();
    let operationOutcome;
    try {
        operationOutcome = {
            ok: true,
            value: await Promise.resolve().then(() => operation())
        };
    }
    catch (error) {
        operationOutcome = { ok: false, error };
    }
    finally {
        clearInterval(timer);
        // Snapshot then join the last single-flight heartbeat. Its catch handler
        // records the authoritative lease/control error and resolves this promise.
        const finalHeartbeat = heartbeatInFlight;
        if (finalHeartbeat)
            await finalHeartbeat;
    }
    // Heartbeat authority wins even when the operation also rejected. Otherwise
    // a concurrent supersession/cancel could be misreported as defer/failure.
    if (heartbeatFailed)
        throw heartbeatError;
    if (!operationOutcome.ok)
        throw operationOutcome.error;
    return operationOutcome.value;
}
const BOUND_IDENTITY_KEYS = [
    "schemaVersion",
    "hostActionId",
    "runId",
    "shardId",
    "pipeline",
    "compiledDigest",
    "itemCount",
    "itemSetDigest",
    "identityDigest"
];
function snapshotExactDataRecord(value, expected, label) {
    if (value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || nodeTypes.isProxy(value)) {
        throw new Error(`${label} must be a plain data object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} must be a plain data object`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (actual.some((key) => typeof key !== "string")) {
        throw new Error(`${label} has unexpected symbol keys`);
    }
    const actualStrings = actual.sort();
    const wanted = [...expected].sort();
    if (actualStrings.length !== wanted.length
        || actualStrings.some((key, index) => key !== wanted[index])) {
        throw new Error(`${label} has unexpected keys`);
    }
    const snapshot = {};
    for (const key of expected) {
        const descriptor = descriptors[key];
        if (descriptor === undefined
            || !("value" in descriptor)
            || descriptor.enumerable !== true) {
            throw new Error(`${label}.${key} must be an enumerable data property`);
        }
        // Capture each caller-owned field exactly once without invoking accessors.
        snapshot[key] = descriptor.value;
    }
    return snapshot;
}
function snapshotOptionRecord(value, allowedKeys, requiredKeys, label) {
    if (value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || nodeTypes.isProxy(value)
        || (Object.getPrototypeOf(value) !== Object.prototype
            && Object.getPrototypeOf(value) !== null)) {
        throw new Error(`${label} must be a plain data object`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set(allowedKeys);
    const actual = Reflect.ownKeys(descriptors);
    if (actual.some((key) => typeof key !== "string" || !allowed.has(key))) {
        throw new Error(`${label} has unexpected keys`);
    }
    for (const key of requiredKeys) {
        if (!Object.prototype.hasOwnProperty.call(descriptors, key)) {
            throw new Error(`${label}.${key} is required`);
        }
    }
    const snapshot = {};
    for (const key of actual) {
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || descriptor.enumerable !== true) {
            throw new Error(`${label}.${key} must be an enumerable data property`);
        }
        Object.defineProperty(snapshot, key, {
            configurable: false,
            enumerable: true,
            writable: false,
            value: descriptor.value
        });
    }
    return Object.freeze(snapshot);
}
function captureObjectMethod(target, key, label) {
    if (target === null
        || (typeof target !== "object" && typeof target !== "function")
        || nodeTypes.isProxy(target)) {
        throw new Error(`${label} must be a non-Proxy capability object`);
    }
    let cursor = target;
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
            return (...args) => method.apply(target, args);
        }
        cursor = Object.getPrototypeOf(cursor);
    }
    throw new Error(`${label}.${key} must be a function`);
}
function captureNodeInvoker(value) {
    const invoke = captureObjectMethod(value, "invoke", "node invoker");
    return Object.freeze({
        invoke: (invocation) => invoke(invocation)
    });
}
function capturePipelineStore(value) {
    const methodNames = [
        "claimNextShard",
        "heartbeatShard",
        "completeShard",
        "failShard",
        "deferShard",
        "cancelShard",
        "prepareStageExecution",
        "persistStageSuccess",
        "persistStageFailure",
        "recordDeadLetter"
    ];
    const captured = Object.fromEntries(methodNames.map((methodName) => [
        methodName,
        captureObjectMethod(value, methodName, "pipeline store")
    ]));
    return Object.freeze(captured);
}
function captureBoundEvidenceStore(value) {
    const prepareStageExecution = captureObjectMethod(value, "prepareStageExecution", "bound evidence store");
    const persistStageSuccess = captureObjectMethod(value, "persistStageSuccess", "bound evidence store");
    const persistStageFailure = captureObjectMethod(value, "persistStageFailure", "bound evidence store");
    const recordDeadLetter = captureObjectMethod(value, "recordDeadLetter", "bound evidence store");
    return Object.freeze({
        prepareStageExecution: prepareStageExecution,
        persistStageSuccess: persistStageSuccess,
        persistStageFailure: persistStageFailure,
        recordDeadLetter: recordDeadLetter
    });
}
function captureStageCatalog(value) {
    if (value === null
        || typeof value !== "object"
        || nodeTypes.isProxy(value)
        || !isInstanceOf(value, StageCatalog)) {
        throw new Error("runner catalog must be a StageCatalog instance");
    }
    const resolveExecutable = captureObjectMethod(value, "resolveExecutable", "stage catalog");
    const contracts = value.contracts;
    return Object.freeze({
        contracts,
        resolveExecutable: (stageId, version) => resolveExecutable(stageId, version)
    });
}
const SHARD_RUNNER_OPTION_KEYS = [
    "store",
    "catalog",
    "invoker",
    "leaseOwner",
    "leaseDurationMs",
    "heartbeatEveryMs",
    "maxAttempts",
    "maxAttemptsByNode",
    "runId",
    "shardId",
    "outboxEventsFor",
    "failureOutboxEventsFor",
    "signal",
    "now"
];
const HEARTBEAT_OPTION_KEYS = [
    "store",
    "shardId",
    "leaseToken",
    "everyMs",
    "extendByMs",
    "now",
    "operation"
];
const BOUND_RUNNER_OPTION_KEYS = [
    "shard",
    "evidenceStore",
    "fence",
    "executionIdentity",
    "catalog",
    "invoker",
    "maxAttempts",
    "maxAttemptsByNode",
    "outboxEventsFor",
    "failureOutboxEventsFor",
    "signal",
    "now"
];
function assertIdentityString(value, label) {
    if (typeof value !== "string"
        || value.length < 1
        || value.length > 512
        || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error(`${label} must be a non-empty bounded string without control characters`);
    }
    return value;
}
function assertDigest(value, label) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256 digest`);
    }
    return value;
}
function snapshotJsonData(value, label, ancestors = new WeakSet()) {
    if (value === null
        || typeof value === "string"
        || typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error(`${label} number must be finite`);
        return value;
    }
    if (typeof value !== "object" || nodeTypes.isProxy(value)) {
        throw new Error(`${label} must contain only plain JSON data`);
    }
    if (ancestors.has(value))
        throw new Error(`${label} must not be cyclic`);
    ancestors.add(value);
    try {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype) {
                throw new Error(`${label} must be a plain array`);
            }
            const lengthDescriptor = descriptors.length;
            if (lengthDescriptor === undefined
                || !("value" in lengthDescriptor)
                || typeof lengthDescriptor.value !== "number"
                || !Number.isInteger(lengthDescriptor.value)
                || lengthDescriptor.value < 0) {
                throw new Error(`${label}.length must be a data property`);
            }
            const length = lengthDescriptor.value;
            const keys = Reflect.ownKeys(descriptors);
            if (keys.some((key) => typeof key !== "string"
                || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))
                || keys.length !== length + 1) {
                throw new Error(`${label} must be a dense array without extra keys`);
            }
            const array = Array.from({ length }, (_, index) => {
                const descriptor = descriptors[String(index)];
                if (descriptor === undefined
                    || !("value" in descriptor)
                    || descriptor.enumerable !== true) {
                    throw new Error(`${label}[${index}] must be an enumerable data property`);
                }
                return snapshotJsonData(descriptor.value, `${label}[${index}]`, ancestors);
            });
            return Object.freeze(array);
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error(`${label} must be a plain data object`);
        }
        const object = {};
        for (const key of Reflect.ownKeys(descriptors)) {
            if (typeof key !== "string")
                throw new Error(`${label} has symbol keys`);
            const descriptor = descriptors[key];
            if (!("value" in descriptor) || descriptor.enumerable !== true) {
                throw new Error(`${label}.${key} must be an enumerable data property`);
            }
            Object.defineProperty(object, key, {
                configurable: false,
                enumerable: true,
                writable: false,
                value: snapshotJsonData(descriptor.value, `${label}.${key}`, ancestors)
            });
        }
        return Object.freeze(object);
    }
    finally {
        ancestors.delete(value);
    }
}
function snapshotBoundPipelineShard(value) {
    const snapshot = snapshotJsonData(value, "bound shard");
    const root = snapshotExactDataRecord(snapshot, ["runId", "shardId", "compiled", "items"], "bound shard");
    const runId = assertIdentityString(root.runId, "bound shard runId");
    const shardId = assertIdentityString(root.shardId, "bound shard shardId");
    const compiled = snapshotJsonData(validateCompiledPipeline(root.compiled), "bound shard compiled pipeline");
    if (!Array.isArray(root.items) || root.items.length < 1) {
        throw new Error("bound shard items must be a non-empty array");
    }
    const items = root.items.map((item, index) => {
        const record = snapshotExactDataRecord(item, ["itemId", "ordinal", "input", "inputDigest"], `bound shard items[${index}]`);
        const itemId = assertIdentityString(record.itemId, `bound shard items[${index}].itemId`);
        if (!Number.isInteger(record.ordinal) || record.ordinal < 1) {
            throw new Error(`bound shard items[${index}].ordinal must be a positive integer`);
        }
        const inputDigest = assertDigest(record.inputDigest, `bound shard items[${index}].inputDigest`);
        if (digest(record.input) !== inputDigest) {
            throw new Error(`bound shard items[${index}].inputDigest does not match input`);
        }
        return Object.freeze({
            itemId,
            ordinal: record.ordinal,
            input: record.input,
            inputDigest
        });
    });
    return Object.freeze({
        runId,
        shardId,
        compiled,
        items: Object.freeze(items)
    });
}
function snapshotShardClaim(value) {
    const snapshot = snapshotJsonData(value, "pipeline shard claim");
    const root = snapshotExactDataRecord(snapshot, [
        "runId",
        "shardId",
        "leaseOwner",
        "leaseToken",
        "acquiredAt",
        "expiresAt",
        "compiled",
        "items"
    ], "pipeline shard claim");
    const shard = snapshotBoundPipelineShard({
        runId: root.runId,
        shardId: root.shardId,
        compiled: root.compiled,
        items: root.items
    });
    return Object.freeze({
        ...shard,
        leaseOwner: assertIdentityString(root.leaseOwner, "pipeline shard claim leaseOwner"),
        leaseToken: assertIdentityString(root.leaseToken, "pipeline shard claim leaseToken"),
        acquiredAt: assertIdentityString(root.acquiredAt, "pipeline shard claim acquiredAt"),
        expiresAt: assertIdentityString(root.expiresAt, "pipeline shard claim expiresAt")
    });
}
/**
 * Capture only the immutable identity needed to settle a claim before
 * validating the larger caller-owned payload. If compiled/items are corrupt,
 * this envelope still lets the runner release the exact fenced lease instead
 * of abandoning it until expiry.
 */
function snapshotShardSettlementEnvelope(value) {
    if (value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || nodeTypes.isProxy(value)
        || (Object.getPrototypeOf(value) !== Object.prototype
            && Object.getPrototypeOf(value) !== null)) {
        throw new Error("pipeline shard claim settlement envelope must be a plain data object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const read = (key) => {
        const descriptor = descriptors[key];
        if (descriptor === undefined
            || !("value" in descriptor)
            || descriptor.enumerable !== true) {
            throw new Error(`pipeline shard claim settlement envelope.${key} must be an enumerable data property`);
        }
        return assertIdentityString(descriptor.value, `pipeline shard claim settlement envelope ${key}`);
    };
    return Object.freeze({
        runId: read("runId"),
        shardId: read("shardId"),
        leaseToken: read("leaseToken")
    });
}
function boundItemSetDigest(shard) {
    return digest(shard.items.map((item) => ({
        itemId: item.itemId,
        ordinal: item.ordinal,
        inputDigest: item.inputDigest
    })));
}
/**
 * Seal the immutable identity a host action must present with every bound
 * evidence append. Fence generations may change during takeover; this value
 * must not.
 */
export function createBoundPipelineExecutionIdentity(input) {
    const wrapper = snapshotExactDataRecord(input, ["hostActionId", "shard"], "bound execution identity input");
    const shard = snapshotBoundPipelineShard(wrapper.shard);
    const compiled = snapshotJsonData(validateCompiledPipeline(shard.compiled), "pipeline shard compiled pipeline");
    const payload = {
        schemaVersion: "bound-pipeline-execution.v1",
        hostActionId: assertIdentityString(wrapper.hostActionId, "hostActionId"),
        runId: shard.runId,
        shardId: shard.shardId,
        pipeline: {
            id: compiled.pipeline.id,
            version: compiled.pipeline.version,
            definitionDigest: compiled.pipeline.digest
        },
        compiledDigest: compiled.compiledDigest,
        itemCount: shard.items.length,
        itemSetDigest: boundItemSetDigest(shard)
    };
    return Object.freeze({
        ...payload,
        pipeline: Object.freeze(payload.pipeline),
        identityDigest: digest(payload)
    });
}
/** Validate the seal and its exact correspondence to the supplied shard. */
export function validateBoundPipelineExecutionIdentity(value, shard) {
    const canonicalShard = snapshotBoundPipelineShard(shard);
    const compiled = validateCompiledPipeline(canonicalShard.compiled);
    const identity = snapshotExactDataRecord(value, BOUND_IDENTITY_KEYS, "bound execution identity");
    if (identity.schemaVersion !== "bound-pipeline-execution.v1") {
        throw new Error("bound execution identity schemaVersion is unsupported");
    }
    const hostActionId = assertIdentityString(identity.hostActionId, "bound execution identity hostActionId");
    const runId = assertIdentityString(identity.runId, "bound execution identity runId");
    const shardId = assertIdentityString(identity.shardId, "bound execution identity shardId");
    const pipeline = snapshotExactDataRecord(identity.pipeline, ["id", "version", "definitionDigest"], "bound execution identity pipeline");
    const pipelineId = assertIdentityString(pipeline.id, "bound execution identity pipeline.id");
    const pipelineVersion = pipeline.version;
    if (!Number.isInteger(pipelineVersion) || pipelineVersion < 1) {
        throw new Error("bound execution identity pipeline.version must be a positive integer");
    }
    const definitionDigest = assertDigest(pipeline.definitionDigest, "bound execution identity pipeline.definitionDigest");
    const compiledDigest = assertDigest(identity.compiledDigest, "bound execution identity compiledDigest");
    const itemSetDigest = assertDigest(identity.itemSetDigest, "bound execution identity itemSetDigest");
    const identityDigest = assertDigest(identity.identityDigest, "bound execution identity identityDigest");
    const itemCount = identity.itemCount;
    if (!Number.isInteger(itemCount) || itemCount < 1) {
        throw new Error("bound execution identity itemCount must be a positive integer");
    }
    const expectedItemSetDigest = boundItemSetDigest(canonicalShard);
    if (runId !== canonicalShard.runId
        || shardId !== canonicalShard.shardId
        || pipelineId !== compiled.pipeline.id
        || pipelineVersion !== compiled.pipeline.version
        || definitionDigest !== compiled.pipeline.digest
        || compiledDigest !== compiled.compiledDigest
        || itemCount !== canonicalShard.items.length
        || itemSetDigest !== expectedItemSetDigest) {
        throw new Error("bound execution identity does not match the immutable shard");
    }
    const payload = {
        schemaVersion: "bound-pipeline-execution.v1",
        hostActionId,
        runId,
        shardId,
        pipeline: {
            id: pipelineId,
            version: pipelineVersion,
            definitionDigest
        },
        compiledDigest,
        itemCount: itemCount,
        itemSetDigest
    };
    if (digest(payload) !== identityDigest) {
        throw new Error("bound execution identity digest does not match its payload");
    }
    // Never retain or pass through caller-owned/deserialized objects. The one
    // canonical frozen snapshot returned here is reused for every async append,
    // closing mutation races between validation and persistence.
    return Object.freeze({
        ...payload,
        pipeline: Object.freeze(payload.pipeline),
        identityDigest
    });
}
/**
 * The single node-walk implementation shared by Pipeline-owned and
 * externally fenced runners. It contains no lease lifecycle operations.
 */
async function executeShardNodes(input) {
    const { shard } = input;
    const compiled = snapshotJsonData(validateCompiledPipeline(shard.compiled), "pipeline shard compiled pipeline");
    const unsupportedNode = compiled.nodes.find((node) => node.deliverySemantics === "at_most_once");
    if (unsupportedNode !== undefined) {
        throw new PipelineStageError("at_most_once_execution_unsupported", false, new Error(`pipeline contains at_most_once node ${unsupportedNode.nodeId}; v0.2 rejects the whole DAG before stage invocation`), "shard");
    }
    if (typeof shard.runId !== "string"
        || shard.runId.length === 0
        || typeof shard.shardId !== "string"
        || shard.shardId.length === 0) {
        throw new Error("Bound pipeline shard immutable configuration requires non-empty runId and shardId");
    }
    if (shard.items.length === 0) {
        throw new Error("Bound pipeline shard immutable configuration must contain at least one item");
    }
    const itemIds = new Set();
    const ordinals = new Set();
    let lastOrdinal = 0;
    for (const item of shard.items) {
        if (typeof item.itemId !== "string"
            || item.itemId.length === 0
            || itemIds.has(item.itemId)) {
            throw new Error("Bound pipeline shard immutable configuration requires non-empty, unique itemId values");
        }
        if (!Number.isInteger(item.ordinal)
            || item.ordinal < 1
            || ordinals.has(item.ordinal)
            || item.ordinal <= lastOrdinal) {
            throw new Error("Bound pipeline shard immutable configuration requires positive, unique, ascending ordinals");
        }
        let actualInputDigest;
        try {
            actualInputDigest = digest(item.input);
        }
        catch (error) {
            throw new Error(`Bound pipeline shard item ${item.itemId} input is not digestable immutable configuration`, { cause: error });
        }
        if (actualInputDigest !== item.inputDigest) {
            throw new Error(`Bound pipeline shard item ${item.itemId} inputDigest does not match its input`);
        }
        itemIds.add(item.itemId);
        ordinals.add(item.ordinal);
        lastOrdinal = item.ordinal;
    }
    let stageExecutionCount = 0;
    let reusedStageCount = 0;
    let terminalItemCount = 0;
    for (const item of shard.items) {
        const artifacts = new Map();
        for (const node of compiled.nodes) {
            const slots = node.inputs.map((nodeInput) => ({
                slot: nodeInput.slot,
                contract: nodeInput.contract,
                value: nodeInput.source.kind === "pipeline_input"
                    ? item.input
                    : artifacts.get(nodeInput.source.nodeId)
            }));
            if (slots.some(({ value }) => value === undefined)) {
                throw new Error(`Pipeline node ${node.nodeId} resolved an undefined input artifact — compiled topology violated`);
            }
            const executable = input.catalog.resolveExecutable(node.stage.id, node.stage.version);
            let invoke;
            if (node.kind === "code") {
                const run = executable.run;
                if (typeof run !== "function") {
                    throw new Error(`Stage ${node.stage.id}@${node.stage.version} is kind "code" but its executable has no run() function`);
                }
                invoke = (value, ctx) => run.call(executable, value, ctx);
            }
            else {
                const invoker = input.invoker;
                if (!invoker) {
                    throw new Error(`No NodeInvoker is configured for non-code pipeline node ${node.nodeId} (kind "${node.kind}")`);
                }
                invoke = (value, ctx) => invoker.invoke({
                    runId: shard.runId,
                    itemId: item.itemId,
                    node,
                    input: value,
                    attempt: ctx.attempt ?? 1,
                    idempotencyKey: ctx.idempotencyKey,
                    ...(ctx.signal === undefined ? {} : { signal: ctx.signal })
                });
            }
            const result = await input.executeStage({ item, node, slots, invoke });
            stageExecutionCount += 1;
            if (result.status === "terminal") {
                terminalItemCount += 1;
                break;
            }
            if (result.reused)
                reusedStageCount += 1;
            artifacts.set(node.nodeId, result.output);
        }
    }
    return {
        itemCount: shard.items.length,
        completedItemCount: shard.items.length - terminalItemCount,
        terminalItemCount,
        stageExecutionCount,
        reusedStageCount
    };
}
async function settleShardControl(error, claim, store, now) {
    if (isInstanceOf(error, PipelineShardDeferredError)) {
        // A control outcome is true only after its fenced durable settlement.
        // Lost fences therefore propagate instead of manufacturing audit truth.
        await store.deferShard({
            shardId: claim.shardId,
            leaseToken: claim.leaseToken,
            reasonCode: error.reasonCode,
            at: now().toISOString()
        });
        return {
            status: "deferred",
            runId: claim.runId,
            shardId: claim.shardId,
            reasonCode: error.reasonCode
        };
    }
    if (isInstanceOf(error, PipelineShardCancelledError)) {
        await store.cancelShard({
            shardId: claim.shardId,
            leaseToken: claim.leaseToken,
            reasonCode: error.reasonCode,
            at: now().toISOString()
        });
        return {
            status: "cancelled",
            runId: claim.runId,
            shardId: claim.shardId,
            reasonCode: error.reasonCode
        };
    }
    return undefined;
}
/**
 * Claim and process AT MOST ONE shard (idle when nothing is claimable).
 * Per-item failure isolation: a terminal item breaks out of ITS node loop
 * (downstream nodes skipped) while the other items continue; only shard-scoped
 * failures (lease lost, immutable configuration/contract rejections) abort the
 * whole shard via failShard. Finalization is derived from persisted evidence
 * by completeShard once every member is resolved.
 */
export async function runOneShard(options) {
    const fields = snapshotOptionRecord(options, SHARD_RUNNER_OPTION_KEYS, ["store", "catalog", "leaseOwner"], "runOneShard options");
    const store = capturePipelineStore(fields.store);
    const catalog = captureStageCatalog(fields.catalog);
    const leaseOwner = assertIdentityString(fields.leaseOwner, "runOneShard leaseOwner");
    const invoker = fields.invoker === undefined
        ? undefined
        : captureNodeInvoker(fields.invoker);
    const outboxEventsFor = fields.outboxEventsFor;
    if (outboxEventsFor !== undefined && typeof outboxEventsFor !== "function") {
        throw new Error("runOneShard: outboxEventsFor must be a function");
    }
    const failureOutboxEventsFor = fields.failureOutboxEventsFor;
    if (failureOutboxEventsFor !== undefined
        && typeof failureOutboxEventsFor !== "function") {
        throw new Error("runOneShard: failureOutboxEventsFor must be a function");
    }
    const maxAttemptsByNode = fields.maxAttemptsByNode === undefined
        ? undefined
        : snapshotJsonData(fields.maxAttemptsByNode, "runOneShard maxAttemptsByNode");
    const leaseDurationMs = fields.leaseDurationMs ?? 1_200_000;
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) {
        throw new Error("runOneShard: leaseDurationMs must be a positive integer");
    }
    const heartbeatEveryMs = fields.heartbeatEveryMs
        ?? Math.max(10_000, Math.floor(leaseDurationMs / 3));
    if (!Number.isInteger(heartbeatEveryMs) || heartbeatEveryMs < 1 || heartbeatEveryMs >= leaseDurationMs) {
        throw new Error("runOneShard: heartbeatEveryMs must be a positive integer less than leaseDurationMs");
    }
    const maxAttempts = fields.maxAttempts ?? 2;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
        throw new Error("runOneShard: maxAttempts must be an integer from 1 through 10");
    }
    if ((fields.runId === undefined) !== (fields.shardId === undefined)) {
        throw new Error("runOneShard: an exact shard run requires both runId and shardId");
    }
    const nowCandidate = fields.now ?? (() => new Date());
    if (typeof nowCandidate !== "function") {
        throw new Error("runOneShard: now must be a function");
    }
    const now = nowCandidate;
    const capturedOptions = Object.freeze({
        store,
        catalog,
        leaseOwner,
        leaseDurationMs,
        heartbeatEveryMs,
        maxAttempts,
        ...(invoker === undefined ? {} : { invoker }),
        ...(maxAttemptsByNode === undefined ? {} : { maxAttemptsByNode }),
        ...(fields.runId === undefined
            ? {}
            : { runId: fields.runId, shardId: fields.shardId }),
        ...(outboxEventsFor === undefined ? {} : { outboxEventsFor }),
        ...(failureOutboxEventsFor === undefined ? {} : { failureOutboxEventsFor }),
        ...(fields.signal === undefined ? {} : { signal: fields.signal }),
        now
    });
    const claimRaw = await store.claimNextShard({
        leaseOwner,
        leaseDurationMs,
        ...(fields.runId === undefined
            ? {}
            : { runId: fields.runId, shardId: fields.shardId }),
        at: now().toISOString()
    });
    if (!claimRaw)
        return { status: "idle" };
    // Capture the fence envelope first. Full claim validation is intentionally
    // inside the settlement guard so corrupt compiled/item evidence does not
    // strand a valid lease for its entire duration.
    const settlementClaim = snapshotShardSettlementEnvelope(claimRaw);
    try {
        const claim = snapshotShardClaim(claimRaw);
        return await processClaim(claim, capturedOptions);
    }
    catch (error) {
        const controlOutcome = await settleShardControl(error, settlementClaim, store, now);
        if (controlOutcome)
            return controlOutcome;
        const failure = classifyStageFailure(error);
        try {
            await store.failShard({
                shardId: settlementClaim.shardId,
                leaseToken: settlementClaim.leaseToken,
                retryable: failure.retryable,
                errorCode: failure.code,
                at: now().toISOString()
            });
        }
        catch (finishError) {
            // A lost fence cannot prove that this failure was recorded. It may mean
            // a concurrent claimant owns the shard, or that completeShard committed
            // and only its response was lost. Propagate the typed authority loss;
            // returning status:"failed" here would manufacture settlement evidence.
            if (isInstanceOf(finishError, ShardLeaseLostError)) {
                throw finishError;
            }
            else {
                // A host may discover authoritative defer/cancel state only while
                // revalidating inside failShard's settlement transaction. Route that
                // late control through the same fenced settlement instead of appending
                // or reporting a false shard failure.
                const lateControlOutcome = await settleShardControl(finishError, settlementClaim, store, now);
                if (lateControlOutcome)
                    return lateControlOutcome;
                throw finishError;
            }
        }
        return {
            status: "failed",
            runId: settlementClaim.runId,
            shardId: settlementClaim.shardId,
            retryable: failure.retryable,
            errorCode: failure.code
        };
    }
}
/**
 * Execute an already-bound shard under a host-owned fence.
 *
 * The runner performs only digest/contract validation, durable stage evidence,
 * invocation, retry routing, and deterministic node traversal. It cannot
 * claim, heartbeat, defer, cancel, complete, fail, or release host work
 * because those operations do not exist on {@link BoundPipelineEvidenceStore}.
 * The host validates the returned outcome and performs its one authoritative
 * settlement transaction.
 */
export async function runBoundShard(options) {
    const fields = snapshotOptionRecord(options, BOUND_RUNNER_OPTION_KEYS, ["shard", "evidenceStore", "fence", "executionIdentity", "catalog"], "runBoundShard options");
    const maxAttempts = fields.maxAttempts ?? 2;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
        throw new Error("runBoundShard: maxAttempts must be an integer from 1 through 10");
    }
    const nowCandidate = fields.now ?? (() => new Date());
    if (typeof nowCandidate !== "function") {
        throw new Error("runBoundShard: now must be a function");
    }
    const now = nowCandidate;
    const catalog = captureStageCatalog(fields.catalog);
    const evidenceStore = captureBoundEvidenceStore(fields.evidenceStore);
    const fence = fields.fence;
    const invoker = fields.invoker === undefined
        ? undefined
        : captureNodeInvoker(fields.invoker);
    const outboxEventsFor = fields.outboxEventsFor;
    if (outboxEventsFor !== undefined && typeof outboxEventsFor !== "function") {
        throw new Error("runBoundShard: outboxEventsFor must be a function");
    }
    const failureOutboxEventsFor = fields.failureOutboxEventsFor;
    if (failureOutboxEventsFor !== undefined
        && typeof failureOutboxEventsFor !== "function") {
        throw new Error("runBoundShard: failureOutboxEventsFor must be a function");
    }
    const maxAttemptsByNode = fields.maxAttemptsByNode === undefined
        ? undefined
        : snapshotJsonData(fields.maxAttemptsByNode, "runBoundShard maxAttemptsByNode");
    // Capture every caller-owned byte once before any async boundary. All
    // evidence and outcomes below use only this canonical frozen snapshot.
    const shard = snapshotBoundPipelineShard(fields.shard);
    try {
        const executionIdentity = validateBoundPipelineExecutionIdentity(fields.executionIdentity, shard);
        const compiled = snapshotJsonData(validateCompiledPipeline(shard.compiled), "bound shard compiled pipeline");
        const unsafeNode = compiled.nodes.find((node) => node.deliverySemantics === "at_most_once");
        if (unsafeNode !== undefined) {
            throw new PipelineStageError("at_most_once_execution_unsupported", false, new Error(`node ${unsafeNode.nodeId} declares at_most_once, which v0.2 rejects before invocation: crash-safe execution requires durable intent plus indeterminate-effect reconciliation`), "shard");
        }
        const metrics = await executeShardNodes({
            shard,
            catalog,
            ...(invoker === undefined ? {} : { invoker }),
            executeStage: ({ item, node, slots, invoke }) => executeBoundDurableStage({
                evidenceStore,
                fence,
                executionIdentity,
                contracts: catalog.contracts,
                runId: shard.runId,
                itemId: item.itemId,
                node,
                slots,
                invoke,
                maxAttempts: maxAttemptsByNode?.[node.nodeId] ?? maxAttempts,
                ...(outboxEventsFor === undefined
                    ? {}
                    : {
                        outboxEvents: (output, { runId, attempt, idempotencyKey }) => assembleBoundOutbox("assemble_success_outbox", () => outboxEventsFor({
                            runId,
                            node,
                            itemId: item.itemId,
                            output,
                            attempt,
                            idempotencyKey
                        }))
                    }),
                ...(failureOutboxEventsFor === undefined
                    ? {}
                    : {
                        failureOutboxEvents: (context) => assembleBoundOutbox("assemble_failure_outbox", () => failureOutboxEventsFor(context))
                    }),
                ...(fields.signal === undefined
                    ? {}
                    : { signal: fields.signal }),
                now
            })
        });
        if (metrics.terminalItemCount > 0) {
            return {
                status: "partial",
                runId: shard.runId,
                shardId: shard.shardId,
                itemCount: metrics.itemCount,
                completedItemCount: metrics.completedItemCount,
                terminalItemCount: metrics.terminalItemCount,
                stageExecutionCount: metrics.stageExecutionCount,
                reusedStageCount: metrics.reusedStageCount
            };
        }
        return {
            status: "completed",
            runId: shard.runId,
            shardId: shard.shardId,
            itemCount: metrics.itemCount,
            stageExecutionCount: metrics.stageExecutionCount,
            reusedStageCount: metrics.reusedStageCount
        };
    }
    catch (error) {
        // External authority failures are not stage outcomes. The host needs the
        // original typed rejection to decide whether its task was fenced/reclaimed.
        if (isInstanceOf(error, ExternalFenceRejectedError)
            || isInstanceOf(error, BoundEvidencePersistenceError)
            || isInstanceOf(error, OutboxEvidenceNotCommittedError)
            || isInstanceOf(error, StageEvidenceAssemblyError)
            || isInstanceOf(error, StageResultConflictError)
            || isInstanceOf(error, EvidenceConflictError))
            throw error;
        if (isInstanceOf(error, PipelineControlOutcomeError)) {
            return {
                status: "control",
                runId: shard.runId,
                shardId: shard.shardId,
                control: error.outcome
            };
        }
        if (isInstanceOf(error, PipelineShardDeferredError)) {
            return {
                status: "control",
                runId: shard.runId,
                shardId: shard.shardId,
                control: {
                    kind: "deferred",
                    reasonCode: error.reasonCode
                }
            };
        }
        if (isInstanceOf(error, PipelineShardCancelledError)) {
            return {
                status: "control",
                runId: shard.runId,
                shardId: shard.shardId,
                control: {
                    kind: "cancelled",
                    reasonCode: error.reasonCode
                }
            };
        }
        const failure = classifyStageFailure(error);
        return {
            status: "failed",
            runId: shard.runId,
            shardId: shard.shardId,
            retryable: failure.retryable,
            errorCode: failure.code
        };
    }
}
function assembleBoundOutbox(operation, assemble) {
    try {
        return assemble();
    }
    catch (error) {
        if (isInstanceOf(error, BoundEvidencePersistenceError))
            throw error;
        throw new BoundEvidencePersistenceError(operation, error);
    }
}
/**
 * Descriptive alias for hosts that call the pre-bound input an externally
 * claimed shard. This is the same implementation, not a second lifecycle.
 */
export const executeClaimedShard = runBoundShard;
async function processClaim(claim, options) {
    const metrics = await executeShardNodes({
        shard: claim,
        catalog: options.catalog,
        ...(options.invoker === undefined ? {} : { invoker: options.invoker }),
        executeStage: ({ item, node, slots, invoke }) => runWithShardHeartbeat({
            store: options.store,
            shardId: claim.shardId,
            leaseToken: claim.leaseToken,
            everyMs: options.heartbeatEveryMs,
            extendByMs: options.leaseDurationMs,
            now: options.now,
            operation: () => executeDurableStage({
                store: options.store,
                contracts: options.catalog.contracts,
                shardId: claim.shardId,
                leaseToken: claim.leaseToken,
                runId: claim.runId,
                itemId: item.itemId,
                node,
                slots,
                invoke,
                maxAttempts: options.maxAttemptsByNode?.[node.nodeId] ?? options.maxAttempts,
                ...(options.outboxEventsFor === undefined
                    ? {}
                    : {
                        outboxEvents: (output, { runId, attempt, idempotencyKey }) => options.outboxEventsFor({
                            runId,
                            node,
                            itemId: item.itemId,
                            output,
                            attempt,
                            idempotencyKey
                        })
                    }),
                ...(options.failureOutboxEventsFor === undefined
                    ? {}
                    : {
                        failureOutboxEvents: options.failureOutboxEventsFor
                    }),
                ...(options.signal === undefined
                    ? {}
                    : { signal: options.signal }),
                now: options.now
            })
        })
    });
    const finalization = await options.store.completeShard({
        shardId: claim.shardId,
        leaseToken: claim.leaseToken,
        at: options.now().toISOString()
    });
    if (finalization.status === "partial") {
        return {
            status: "partial",
            runId: claim.runId,
            shardId: claim.shardId,
            itemCount: finalization.itemCount,
            completedItemCount: finalization.completedItemCount,
            terminalItemCount: finalization.terminalItemCount,
            stageExecutionCount: metrics.stageExecutionCount,
            reusedStageCount: metrics.reusedStageCount
        };
    }
    return {
        status: "completed",
        runId: claim.runId,
        shardId: claim.shardId,
        itemCount: finalization.itemCount,
        stageExecutionCount: metrics.stageExecutionCount,
        reusedStageCount: metrics.reusedStageCount
    };
}
