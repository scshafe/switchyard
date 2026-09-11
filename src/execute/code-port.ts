// execute/code-port.ts — one code body per node, dispatched on the turn's nodeId.
//
// `WorkerNodePorts` is keyed by node kind, so a host with several code nodes
// otherwise writes a `switch` on `context.nodeId` inside one port. This
// adapter is that switch, done once: bodies are captured at construction as
// data-property functions in a prototype-free record, an unregistered node is
// a terminal configuration rejection before any body runs, and nothing here
// touches routing, stores, leases, or credentials.

import { types as nodeTypes } from "node:util";

import { assertIdentifier } from "../internal/guards.js";
import { ExecutionFailureError } from "./failure.js";
import type {
  CodeNodePort,
  UnmeteredNodeTurnCompletion,
  WorkerNodeTurnContext
} from "./ports.js";

export type CodeNodeBody = (
  input: unknown,
  context: WorkerNodeTurnContext
) => Promise<UnmeteredNodeTurnCompletion>;

export type CodeNodeBodies = Readonly<Record<string, CodeNodeBody>>;

function captureBodies(bodiesRaw: unknown): Readonly<Record<string, CodeNodeBody>> {
  const label = "code node bodies";
  if (
    bodiesRaw === null
    || typeof bodiesRaw !== "object"
    || nodeTypes.isProxy(bodiesRaw)
    || (
      Object.getPrototypeOf(bodiesRaw) !== Object.prototype
      && Object.getPrototypeOf(bodiesRaw) !== null
    )
  ) {
    throw new Error(`${label} must be a plain non-Proxy data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(bodiesRaw);
  const captured = Object.create(null) as Record<string, CodeNodeBody>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new Error(`${label} has symbol keys`);
    assertIdentifier(key, `${label} node id`);
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    const body = descriptor.value;
    if (typeof body !== "function" || nodeTypes.isProxy(body)) {
      throw new Error(`${label}.${key} must be a non-Proxy function`);
    }
    Object.defineProperty(captured, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: body as CodeNodeBody
    });
  }
  return Object.freeze(captured);
}

/**
 * Build a `CodeNodePort` that runs `bodies[context.nodeId]`. A turn at a node
 * with no registered body fails terminally with
 * `immutable_configuration_rejected`, the same code the runner uses for a
 * missing kind port, and invokes nothing.
 */
export function codeNodePortByNode(bodiesRaw: unknown): CodeNodePort {
  const bodies = captureBodies(bodiesRaw);
  return Object.freeze({
    async run(input: unknown, context: WorkerNodeTurnContext): Promise<UnmeteredNodeTurnCompletion> {
      const nodeId = (context as { readonly nodeId?: unknown } | null | undefined)?.nodeId;
      if (typeof nodeId !== "string" || !Object.hasOwn(bodies, nodeId)) {
        throw new ExecutionFailureError(
          "immutable_configuration_rejected",
          false,
          new Error(`code node port has no body registered for node ${String(nodeId)}`)
        );
      }
      return Reflect.apply(bodies[nodeId]!, undefined, [input, context]);
    }
  });
}
