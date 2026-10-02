// Packed-install TypeScript smoke: typechecked in the consumer against the
// shipped .d.ts files (scripts/check-pack-install.mjs), skipLibCheck false.
import {
  GRAPH_VALIDATION_LIMITS,
  compileGraph,
  createGraphDefinition,
  projectGraphDisplay,
  graphDefinitionDiff,
  createJoinInputArtifact,
  validateJoinInputArtifact,
  withDeclaredFailureOutcomes,
  JOIN_INPUT_ARTIFACT_CONTRACT,
  type JoinInputPayload,
  type DeclaredFailureModelPort,
  nodeExecutionFingerprint,
  nodeTurnIdempotencyKey,
  recordHumanNodeDecision,
  runClaimedUnitTurn,
  runNextUnitTurns,
  validateNodeTurnCompletion,
  type CompiledGraph,
  type GraphDefinition,
  type GraphDefinitionDraft,
  type GraphDisplayProjection,
  type GraphDefinitionDiff,
  type SwitchyardNode,
  type ModelBindingResolver,
  type OutcomePredicate,
  type OutcomeVocabulary,
  type TurnExecutionStore,
  type TurnRunnerStore,
  type WorkerNodeTurnContext
} from "@scshafe/switchyard";
import type { UnitStore } from "@scshafe/switchyard/store/unit-store";
import type { ModelInvocationRequest } from "@scshafe/switchyard/model/invoker";
import type { AgentStepExecutor } from "@scshafe/switchyard/agent/executor-port";

const exported = {
  compileGraph,
  createGraphDefinition,
  nodeExecutionFingerprint,
  nodeTurnIdempotencyKey,
  recordHumanNodeDecision,
  runClaimedUnitTurn,
  runNextUnitTurns,
  validateNodeTurnCompletion
};
const draft = undefined as unknown as GraphDefinitionDraft;
const graph = undefined as unknown as GraphDefinition;
const compiled = undefined as unknown as CompiledGraph;
const display: GraphDisplayProjection = projectGraphDisplay(compiled);
const diff: GraphDefinitionDiff = graphDefinitionDiff(graph, graph);
const joinInput: JoinInputPayload = validateJoinInputArtifact(graph,
  createJoinInputArtifact(graph, { unitId: "fixture", nodeId: "join", accepted: [] })).payload;
const modelFailurePort = undefined as unknown as DeclaredFailureModelPort;
// @ts-expect-error model failure recovery requires an explicit receipt policy
withDeclaredFailureOutcomes(modelFailurePort, { kind: "model", outcomes: {}, artifact: () => { throw new Error("fixture"); } });
// @ts-expect-error composition is a closed optional vocabulary
const wrongJoin: import("@scshafe/switchyard").SwitchyardJoin = { inbound: ["edge"], require: "all", compose: "merge" };
void joinInput;
void JOIN_INPUT_ARTIFACT_CONTRACT;
const node = undefined as unknown as SwitchyardNode;
const outcomes = undefined as unknown as OutcomeVocabulary;
const predicate = undefined as unknown as OutcomePredicate;
const store = undefined as unknown as UnitStore;
const runnerStore = undefined as unknown as TurnRunnerStore;
const executionStore = undefined as unknown as TurnExecutionStore;
const context = undefined as unknown as WorkerNodeTurnContext;
const resolver = undefined as unknown as ModelBindingResolver;
const request = undefined as unknown as ModelInvocationRequest;
const executor = undefined as unknown as AgentStepExecutor;
// @ts-expect-error sealed graph arrays are readonly
graph.nodes.push(node);
// @ts-expect-error display topology is readonly
display.nodes[0].depth = 1;
// @ts-expect-error definition diff arrays are readonly
diff.nodes.pop();
// @ts-expect-error node bodies receive no store capability
context.store.prepareTurnAttempt({});
// @ts-expect-error execution stores cannot admit units
executionStore.admitUnit({});
void exported;
void draft;
void compiled;
void outcomes;
void predicate;
void store;
void runnerStore;
void resolver;
void request;
void executor;
void GRAPH_VALIDATION_LIMITS;
