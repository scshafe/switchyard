import type { ContractId, GraphDefinitionRef, MissionPipelineNodeBindingRef, MissionPipelineNodeRef } from "mission-pipeline";

/** Authorized consumer data; identity matching is not proof of sealed contents. */
export interface NodeDetails {
  readonly graph: GraphDefinitionRef;
  readonly nodeId: string;
  readonly sealed: {
    readonly ref: MissionPipelineNodeRef;
    readonly kind: "code" | "model" | "human" | "agent" | "callback";
    readonly input: ContractId;
    readonly outcomes: readonly string[];
    readonly maxAttempts: number;
    readonly leaseMs: number;
    readonly binding?: MissionPipelineNodeBindingRef;
  };
  readonly outputs?: readonly { readonly outcome: string; readonly contractId: ContractId }[];
  readonly model?: {
    readonly name: string;
    readonly id: string;
    readonly version: number;
    readonly providerId?: string;
    readonly parameters: Readonly<Record<string, string | number>>;
    readonly prompt: { readonly digest: string; readonly systemPrompt: string } | { readonly withheld: string };
  };
  readonly implementation?: {
    readonly body: { readonly module: string; readonly symbol: string };
    readonly port: { readonly module: string; readonly symbol: string };
    readonly dispatch?: string;
  };
  readonly question?: string;
}
