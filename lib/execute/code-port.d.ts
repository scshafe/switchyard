import type { CodeNodePort, UnmeteredNodeTurnCompletion, WorkerNodeTurnContext } from "./ports.js";
export type CodeNodeBody = (input: unknown, context: WorkerNodeTurnContext) => Promise<UnmeteredNodeTurnCompletion>;
export type CodeNodeBodies = Readonly<Record<string, CodeNodeBody>>;
/**
 * Build a `CodeNodePort` that runs `bodies[context.nodeId]`. A turn at a node
 * with no registered body fails terminally with
 * `immutable_configuration_rejected`, the same code the runner uses for a
 * missing kind port, and invokes nothing.
 */
export declare function codeNodePortByNode(bodiesRaw: unknown): CodeNodePort;
