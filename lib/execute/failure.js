// execute/failure.ts — the traversal-neutral retryable-versus-terminal
// execution-failure taxonomy used by v2 node turns. It deliberately knows
// nothing about graphs, queues, stores, providers, or credentials.
import { types as nodeTypes } from "node:util";
// Failure codes are durable identifiers and must remain readable by every
// recovery path that uses the shared identifier grammar (1..160 chars).
const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9._:-]{0,159}$/;
const executionFailureErrors = new WeakSet();
/** A deliberate failure whose stable code and retry disposition are trusted. */
export class ExecutionFailureError extends Error {
    code;
    retryable;
    constructor(code, retryable, cause) {
        super(code, cause === undefined ? undefined : { cause });
        this.name = "ExecutionFailureError";
        this.code = code;
        this.retryable = retryable;
        executionFailureErrors.add(this);
    }
}
/** Descriptor-free brand check safe for hostile thrown Proxy values. */
export function isExecutionFailureError(value) {
    return isObjectLike(value) && executionFailureErrors.has(value);
}
function isObjectLike(value) {
    return value !== null && (typeof value === "object" || typeof value === "function");
}
/**
 * Read Error.name/message with ordinary property-lookup semantics, but only
 * through data descriptors. Accessors and Proxy-backed prototype links are
 * treated as unavailable rather than executed.
 */
function inheritedStringDataProperty(value, key) {
    let cursor = value;
    while (cursor !== null) {
        if (nodeTypes.isProxy(cursor))
            return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
        if (descriptor !== undefined) {
            return "value" in descriptor && typeof descriptor.value === "string"
                ? descriptor.value
                : undefined;
        }
        cursor = Object.getPrototypeOf(cursor);
    }
    return undefined;
}
/** Descriptor-only equivalent of the legacy `value instanceof Error` test. */
function safeErrorText(value) {
    if (!isObjectLike(value) || nodeTypes.isProxy(value))
        return "";
    let cursor = value;
    let isError = false;
    while (cursor !== null) {
        if (nodeTypes.isProxy(cursor))
            return "";
        if (cursor === Error.prototype) {
            isError = true;
            break;
        }
        cursor = Object.getPrototypeOf(cursor);
    }
    if (!isError)
        return "";
    const name = inheritedStringDataProperty(value, "name") ?? "";
    const message = inheritedStringDataProperty(value, "message") ?? "";
    return `${name} ${message}`;
}
function classifyTypedExecutionFailure(error) {
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const code = descriptors.code;
    const retryable = descriptors.retryable;
    if (code !== undefined
        && "value" in code
        && typeof code.value === "string"
        && FAILURE_CODE_PATTERN.test(code.value)
        && retryable !== undefined
        && "value" in retryable
        && typeof retryable.value === "boolean") {
        return { code: code.value, retryable: retryable.value };
    }
    return { code: "invalid_execution_failure_error", retryable: false };
}
/**
 * Map any thrown value to a stable code plus retry disposition. `retryable:
 * false` is terminal for one v2 unit turn.
 */
export function classifyExecutionFailure(error) {
    try {
        if (isObjectLike(error) && nodeTypes.isProxy(error)) {
            return { code: "untrusted_proxy_error", retryable: false };
        }
        if (isExecutionFailureError(error)) {
            return classifyTypedExecutionFailure(error);
        }
        const text = safeErrorText(error).toLowerCase();
        if (/schema|contract|identity|digest|binding|pipeline node|executable|topolog/.test(text)) {
            return { code: "immutable_configuration_rejected", retryable: false };
        }
        if (/timeout|timed out|fetch|connect|econn|socket|model|503|502|429/.test(text)) {
            return { code: "dependency_unavailable", retryable: true };
        }
        return { code: "stage_execution_failed", retryable: true };
    }
    catch {
        return { code: "stage_failure_classification_failed", retryable: false };
    }
}
