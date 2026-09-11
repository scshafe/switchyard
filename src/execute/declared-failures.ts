// execute/declared-failures.ts — consumer-owned failure recovery policy.
// No provider admission, telemetry, or settlement is inferred from an error.
import { types as nodeTypes } from "node:util";
import { validateArtifactEnvelope, type ArtifactEnvelope } from "../contracts/artifact.js";
import { validateUsageReceipt, type UsageReceipt } from "../contracts/usage-receipt.js";
import { validateSwitchyardNodeBindingRef, type SwitchyardNodeBindingRef } from "../graph/definition.js";
import { captureCapabilityDataProperty, captureCapabilityRecord } from "../internal/capability.js";
import { assertIdentifier } from "../internal/guards.js";
import { classifyExecutionFailure, ExecutionFailureError, isExecutionFailureError, type ExecutionFailure } from "./failure.js";
import {
  ENGINE_JOIN_UNSATISFIABLE_OUTCOME,
  MAX_AGENT_TURN_USAGE_RECEIPTS,
  snapshotNodeTurnCompletion,
  snapshotWorkerNodeTurnContext,
  type AgentNodePort,
  type AgentNodeTurnCompletion,
  type CodeNodePort,
  type ModelNodePort,
  type ModelNodeTurnCompletion,
  type NodeTurnCompletion,
  type UnmeteredNodeTurnCompletion,
  type WorkerNodeTurnContext
} from "./ports.js";

export type DeclaredFailurePortKind = "code" | "model" | "agent";
export type DeclaredFailureOperation = "code_run" | "model_invoke" | "agent_submit" | "agent_await";
export type DeclaredFailureAdmission = "unknown" | "not_admitted" | "admitted";

/** Invocation-local capability, supplied as the port's trailing argument. */
export interface DeclaredFailureEvidenceCapture {
  /** Explicit host knowledge only. An admitted invocation cannot be downgraded. */
  readonly setAdmission: (admission: DeclaredFailureAdmission) => void;
  /** Append one validated receipt (at most one for model, 256 for agent). */
  readonly recordUsage: (receipt: UsageReceipt) => void;
  /** Pending/interrupted work must remain unresolved, even with a typed error. */
  readonly markUnresolved: () => void;
}

export interface DeclaredFailureEvidence {
  readonly admission: DeclaredFailureAdmission;
  readonly usage: readonly UsageReceipt[];
}

/** Detached policy input. The error object itself never grants evidence. */
export interface DeclaredFailureInvocation {
  readonly kind: DeclaredFailurePortKind;
  readonly operation: DeclaredFailureOperation;
  readonly input: unknown;
  readonly context: WorkerNodeTurnContext;
  readonly binding?: SwitchyardNodeBindingRef;
  readonly failure: ExecutionFailure;
  readonly evidence: DeclaredFailureEvidence;
}

export interface DeclaredFailureCodePort {
  readonly run: (input: unknown, context: WorkerNodeTurnContext, evidence: DeclaredFailureEvidenceCapture) => Promise<UnmeteredNodeTurnCompletion>;
}
export interface DeclaredFailureModelPort {
  readonly invoke: (input: unknown, binding: SwitchyardNodeBindingRef, context: WorkerNodeTurnContext, evidence: DeclaredFailureEvidenceCapture) => Promise<ModelNodeTurnCompletion>;
}
export interface DeclaredFailureAgentPort {
  readonly submitTurnIntent: (input: unknown, context: WorkerNodeTurnContext, evidence: DeclaredFailureEvidenceCapture) => Promise<void>;
  readonly awaitSettledResult: (context: WorkerNodeTurnContext, evidence: DeclaredFailureEvidenceCapture) => Promise<AgentNodeTurnCompletion>;
}

export interface DeclaredFailureOptions<K extends DeclaredFailurePortKind> {
  readonly kind: K;
  readonly outcomes: Readonly<Record<string, string>>;
  readonly artifact: (invocation: DeclaredFailureInvocation) => ArtifactEnvelope | Promise<ArtifactEnvelope>;
}
export interface DeclaredFailureCodeOptions extends DeclaredFailureOptions<"code"> {
  readonly receipt?: never;
}
export interface DeclaredFailureModelOptions extends DeclaredFailureOptions<"model"> {
  /** Used only when no validated receipt was captured. No receipt is synthesized by the helper. */
  readonly receipt: (invocation: DeclaredFailureInvocation) => readonly [UsageReceipt] | Promise<readonly [UsageReceipt]>;
}
export interface DeclaredFailureAgentOptions extends DeclaredFailureOptions<"agent"> {
  /** Used only when no receipts were captured; omission explicitly permits an empty collection. */
  readonly receipt?: (invocation: DeclaredFailureInvocation) => readonly UsageReceipt[] | Promise<readonly UsageReceipt[]>;
}

type Options = DeclaredFailureCodeOptions | DeclaredFailureModelOptions | DeclaredFailureAgentOptions;
type AnyFunction = (...args: any[]) => any;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const EMPTY_USAGE: readonly UsageReceipt[] = Object.freeze([]);

function frozenRecord<T extends object>(value: T): T {
  return Object.freeze(Object.assign(Object.create(null), value)) as T;
}

/** Input has already passed a bounded strict validator before this conversion. */
function prototypeFree<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(prototypeFree)) as T;
  const result = Object.create(null);
  for (const key of Object.keys(value)) {
    Object.defineProperty(result, key, { value: prototypeFree((value as Record<string, unknown>)[key]), enumerable: true });
  }
  return Object.freeze(result) as T;
}

function captureFunction(value: unknown, label: string): AnyFunction {
  if (typeof value !== "function" || nodeTypes.isProxy(value)) throw new Error(`${label} must be a non-Proxy data-property function`);
  return value as AnyFunction;
}
function captureMethod(port: unknown, key: string): AnyFunction {
  const method = captureFunction(captureCapabilityDataProperty(port, key, "declared failure port"), `declared failure port.${key}`);
  return (...args: any[]) => Reflect.apply(method, port, args);
}
function captureOutcomes(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("declared failure outcomes must be a plain non-Proxy data object");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256) throw new Error("declared failure outcomes must contain at most 256 mappings");
  const result = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("declared failure outcomes must not have symbol keys");
    assertIdentifier(key, "declared failure code");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) throw new Error("declared failure outcome must be an enumerable data property");
    const outcome = assertIdentifier(descriptor.value, "declared failure outcome");
    if (outcome === ENGINE_JOIN_UNSATISFIABLE_OUTCOME) throw new Error("declared failure outcome is engine-reserved");
    result[key] = outcome;
  }
  return Object.freeze(result);
}

interface InvocationState {
  readonly input: unknown;
  readonly context: WorkerNodeTurnContext;
  readonly binding?: SwitchyardNodeBindingRef;
  readonly capture: DeclaredFailureEvidenceCapture;
  admission: DeclaredFailureAdmission;
  usage: readonly UsageReceipt[];
  active: boolean;
  unresolved: boolean;
  completion?: NodeTurnCompletion;
  awaiting?: boolean;
}

function paid(receipt: UsageReceipt): boolean {
  return receipt.chargedTokens > 0 || receipt.chargedCostMicroUsd > 0
    || (receipt.observedInputTokens ?? 0) > 0 || (receipt.observedOutputTokens ?? 0) > 0
    || (receipt.observedCostMicroUsd ?? 0) > 0;
}
function assertAdmissionUsage(state: InvocationState, usage: readonly UsageReceipt[]): void {
  if (state.admission === "not_admitted" && usage.some(paid)) {
    throw new Error("not_admitted invocation cannot carry paid or positive observed usage");
  }
}
function signalAborted(context: WorkerNodeTurnContext): boolean {
  return context.signal !== undefined && Reflect.apply(abortedGetter, context.signal, []);
}
function assertNotAborted(context: WorkerNodeTurnContext): void {
  if (signalAborted(context)) {
    const error = new Error("Declared failure invocation aborted");
    error.name = "AbortError";
    throw error;
  }
}
function cancellation(error: unknown): boolean {
  if (error === null || (typeof error !== "object" && typeof error !== "function") || nodeTypes.isProxy(error)) return false;
  let cursor: object | null = error;
  while (cursor !== null && !nodeTypes.isProxy(cursor)) {
    for (const key of ["name", "code"]) {
      const property = Object.getOwnPropertyDescriptor(cursor, key);
      if (property !== undefined && "value" in property && typeof property.value === "string"
        && /^(AbortError|ABORT_ERR|ERR_CANCELLED|ERR_CANCELED|cancel(?:led|ed|lation)Error|abort(?:ed)?|cancel(?:led|ed|lation)?)$/i.test(property.value)) return true;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return false;
}

// Thrown objects retain their identity on pass-through. Evidence lives outside
// the error, keyed by the exact attempt; hostile properties are never read.
const recoveryEvidence = new WeakMap<object, Map<string, readonly UsageReceipt[]>>();
function retainUsage(error: unknown, state: InvocationState): void {
  if (state.usage.length === 0 || error === null || (typeof error !== "object" && typeof error !== "function")) return;
  let byAttempt = recoveryEvidence.get(error);
  if (byAttempt === undefined) { byAttempt = new Map(); recoveryEvidence.set(error, byAttempt); }
  const key = JSON.stringify([state.context.nodeId, state.context.idempotencyKey]);
  if (!byAttempt.has(key)) byAttempt.set(key, state.usage);
}
class DeclaredFailureUnresolvedError extends Error {
  constructor(state: InvocationState, cause: unknown) {
    super("Declared failure invocation remains unresolved", { cause });
    retainUsage(this, state);
    Object.freeze(this);
  }
}
class DeclaredFailureRecoveryError extends ExecutionFailureError {
  constructor(state: InvocationState, cause: unknown) {
    super("immutable_stage_contract_rejected", false, cause);
    this.name = "DeclaredFailureRecoveryError";
    retainUsage(this, state);
    Object.freeze(this);
  }
}
/** @internal Exact-attempt lookup used by the runner. No public error usage is trusted. */
export function declaredFailureRecoveryUsage(error: unknown, nodeId: string, idempotencyKey: string): readonly UsageReceipt[] | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")
    || typeof nodeId !== "string" || typeof idempotencyKey !== "string") return undefined;
  return recoveryEvidence.get(error)?.get(JSON.stringify([nodeId, idempotencyKey]));
}

export function withDeclaredFailureOutcomes(port: DeclaredFailureCodePort, options: DeclaredFailureCodeOptions): CodeNodePort;
export function withDeclaredFailureOutcomes(port: DeclaredFailureModelPort, options: DeclaredFailureModelOptions): ModelNodePort;
export function withDeclaredFailureOutcomes(port: DeclaredFailureAgentPort, options: DeclaredFailureAgentOptions): AgentNodePort;
/**
 * Map selected definite failures to ordinary completions under explicit host
 * receipt policy. Node declarations and output contracts are still validated
 * by executeNodeTurnAttempt. Agent submit/await must share the same context
 * object; the engine already does so. No invocation state survives a process.
 */
export function withDeclaredFailureOutcomes(port: unknown, options: Options): CodeNodePort | ModelNodePort | AgentNodePort {
  const raw = captureCapabilityRecord(options, ["kind", "outcomes", "artifact", "receipt"], ["kind", "outcomes", "artifact"], "declared failure options");
  const candidateKind = raw.kind;
  if (candidateKind !== "code" && candidateKind !== "model" && candidateKind !== "agent") throw new Error("declared failure options.kind must be code, model, or agent");
  const kind: DeclaredFailurePortKind = candidateKind;
  const outcomes = captureOutcomes(raw.outcomes);
  const artifact = captureFunction(raw.artifact, "declared failure options.artifact");
  if (kind === "code" && Object.hasOwn(raw, "receipt")) throw new Error("code declared failures must not supply a receipt policy");
  if (kind === "model" && !Object.hasOwn(raw, "receipt")) throw new Error("model declared failures require a receipt policy");
  const receiptPolicy = Object.hasOwn(raw, "receipt") ? captureFunction(raw.receipt, "declared failure options.receipt") : undefined;

  function start(input: unknown, contextRaw: WorkerNodeTurnContext, bindingRaw?: SwitchyardNodeBindingRef): InvocationState {
    const context = snapshotWorkerNodeTurnContext(contextRaw);
    assertNotAborted(context);
    const envelope = validateArtifactEnvelope({ ...context.inputArtifact, payload: input });
    const binding = bindingRaw === undefined ? undefined : prototypeFree(validateSwitchyardNodeBindingRef(bindingRaw, "declared failure binding"));
    const ensureActive = () => {
      if (!state.active) throw new Error("declared failure evidence capture is closed");
    };
    const state: InvocationState = {
      input: prototypeFree(envelope.payload), context, ...(binding === undefined ? {} : { binding }),
      admission: "unknown", usage: EMPTY_USAGE, active: true, unresolved: false,
      capture: frozenRecord({
        setAdmission(admission: DeclaredFailureAdmission) {
          ensureActive();
          if (admission !== "unknown" && admission !== "not_admitted" && admission !== "admitted") throw new Error("invalid declared failure admission");
          if (state.admission === "admitted" && admission !== "admitted") throw new Error("admitted invocation cannot be downgraded");
          if (admission === "not_admitted" && state.usage.some(paid)) throw new Error("not_admitted invocation cannot carry paid or positive observed usage");
          state.admission = admission;
        },
        recordUsage(receipt: UsageReceipt) {
          ensureActive();
          if (kind === "code") throw new Error("code invocation must not record usage");
          const next = prototypeFree(validateUsageReceipt(receipt));
          const maximum = kind === "model" ? 1 : MAX_AGENT_TURN_USAGE_RECEIPTS;
          if (state.usage.length >= maximum) throw new Error(`declared failure invocation permits at most ${maximum} receipts`);
          assertAdmissionUsage(state, [next]);
          state.usage = Object.freeze([...state.usage, next]);
        },
        markUnresolved() { ensureActive(); state.unresolved = true; }
      })
    };
    return state;
  }

  async function recover(error: unknown, state: InvocationState, operation: DeclaredFailureOperation): Promise<NodeTurnCompletion> {
    state.active = false;
    retainUsage(error, state);
    if (signalAborted(state.context) || state.unresolved || cancellation(error)) {
      if (kind === "agent" && isExecutionFailureError(error)) throw new DeclaredFailureUnresolvedError(state, error);
      throw error;
    }
    if (kind === "agent" && !isExecutionFailureError(error)) throw error;
    const failure = frozenRecord(classifyExecutionFailure(error));
    if (!Object.hasOwn(outcomes, failure.code)) throw error;
    const invocation: DeclaredFailureInvocation = frozenRecord({
      kind, operation, input: state.input, context: state.context,
      ...(state.binding === undefined ? {} : { binding: state.binding }), failure,
      evidence: frozenRecord({ admission: state.admission, usage: state.usage })
    });
    try {
      if (kind !== "code" && state.usage.length === 0 && receiptPolicy !== undefined) {
        const proposed = await Reflect.apply(receiptPolicy, undefined, [invocation]);
        // Receipt-first extraction retains a valid prefix if a later receipt
        // is malformed. Policy evidence never replaces captured observations.
        try {
          const accepted = prototypeFree(snapshotNodeTurnCompletion({ outcome: "failure_recovery", usage: proposed }).usage);
          assertAdmissionUsage(state, accepted);
          state.usage = accepted;
        } catch (validationError) {
          // This error is created synchronously by the strict snapshot above.
          const descriptor = Object.getOwnPropertyDescriptor(validationError as object, "usage");
          if (descriptor !== undefined && "value" in descriptor) {
            const prefix = prototypeFree(descriptor.value) as readonly UsageReceipt[];
            state.usage = state.admission === "not_admitted"
              ? Object.freeze(prefix.slice(0, prefix.findIndex(paid) < 0 ? prefix.length : prefix.findIndex(paid)))
              : prefix;
          }
          throw validationError;
        }
        assertAdmissionUsage(state, state.usage);
      }
      if (kind === "model" && state.usage.length !== 1) throw new Error("model declared failure requires exactly one receipt");
      if (signalAborted(state.context)) throw error;
      const outputArtifact = prototypeFree(validateArtifactEnvelope(await Reflect.apply(artifact, undefined, [invocation])));
      if (signalAborted(state.context)) throw error;
      return frozenRecord({ outcome: outcomes[failure.code]!, outputArtifact, ...(kind === "code" ? {} : { usage: state.usage }) });
    } catch (recoveryError) {
      retainUsage(recoveryError, state);
      if (signalAborted(state.context) || cancellation(recoveryError)) {
        if (kind === "agent" && isExecutionFailureError(recoveryError)) throw new DeclaredFailureUnresolvedError(state, recoveryError);
        throw recoveryError;
      }
      throw new DeclaredFailureRecoveryError(state, recoveryError);
    }
  }

  if (kind === "code") {
    const run = captureMethod(port, "run");
    return frozenRecord({ async run(input: unknown, context: WorkerNodeTurnContext) {
      const state = start(input, context);
      try { return await run(state.input, state.context, state.capture); }
      catch (error) { return await recover(error, state, "code_run") as UnmeteredNodeTurnCompletion; }
      finally { state.active = false; }
    } });
  }
  if (kind === "model") {
    const invoke = captureMethod(port, "invoke");
    return frozenRecord({ async invoke(input: unknown, binding: SwitchyardNodeBindingRef, context: WorkerNodeTurnContext) {
      const state = start(input, context, binding);
      try { return await invoke(state.input, state.binding, state.context, state.capture); }
      catch (error) { return await recover(error, state, "model_invoke") as ModelNodeTurnCompletion; }
      finally { state.active = false; }
    } });
  }
  const submit = captureMethod(port, "submitTurnIntent");
  const awaitResult = captureMethod(port, "awaitSettledResult");
  const pending = new WeakMap<WorkerNodeTurnContext, InvocationState>();
  return frozenRecord({
    async submitTurnIntent(input: unknown, context: WorkerNodeTurnContext): Promise<void> {
      if (pending.has(context)) throw new Error("agent declared failure invocation already submitted for this context");
      const state = start(input, context);
      pending.set(context, state);
      try { await submit(state.input, state.context, state.capture); }
      catch (error) {
        try { state.completion = await recover(error, state, "agent_submit"); }
        catch (rejection) { pending.delete(context); state.active = false; throw rejection; }
      }
    },
    async awaitSettledResult(context: WorkerNodeTurnContext): Promise<AgentNodeTurnCompletion> {
      const state = pending.get(context);
      if (state === undefined || state.awaiting) throw new Error("agent declared failure await requires its submitted context exactly once");
      state.awaiting = true;
      try {
        assertNotAborted(state.context);
        if (state.completion !== undefined) return state.completion;
        try { return await awaitResult(state.context, state.capture); }
        catch (error) { return await recover(error, state, "agent_await"); }
      } catch (error) {
        retainUsage(error, state);
        throw error;
      } finally { pending.delete(context); state.active = false; }
    }
  });
}
