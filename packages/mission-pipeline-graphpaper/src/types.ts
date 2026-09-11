import type { GoalManifest, GraphDefinition, GraphDefinitionRef, GraphDisplayProjection, TerminalOutcome } from "@scshafe/switchyard";

export const PIPELINE_PRESENTATION_SCHEMA_VERSION = "mission-pipeline-presentation.v1" as const;
export const PIPELINE_DIAGRAM_SCHEMA_VERSION = "mission-pipeline-diagram.v1" as const;

export interface PresentationRow {
  readonly label: string;
  readonly value: string;
}

export interface PipelineNodePresentation {
  readonly name: string;
  readonly summary?: string;
  readonly question?: string;
  readonly rows?: readonly PresentationRow[];
  /** A consumer-resolved name, usable only for the exact sealed binding digest. */
  readonly model?: { readonly bindingDigest: string; readonly name: string };
}

export interface PipelineArrowGroup {
  readonly outcomes: readonly string[];
  readonly label?: string;
  readonly note?: string;
}

export interface PipelineEndpointPresentation {
  readonly id: string;
  readonly name: string;
  readonly system?: string;
  readonly summary?: string;
  readonly exits: readonly TerminalOutcome[];
  /** Explicit presentation connections from human nodes, without runtime state. */
  readonly waits?: readonly string[];
  readonly kind?: string;
  readonly via?: string;
  /** Consumer labels retained as metadata only; the core reads no outbox. */
  readonly outboxEventTypes?: readonly string[];
  readonly rows?: readonly PresentationRow[];
}

export interface PipelineTerminalPresentation {
  readonly id: string;
  readonly name: string;
  readonly summary?: string;
  readonly ends: readonly TerminalOutcome[];
}

export interface PipelinePresentation {
  readonly schemaVersion: typeof PIPELINE_PRESENTATION_SCHEMA_VERSION;
  readonly title: string;
  readonly subtitle?: string;
  readonly id?: string;
  readonly description?: string;
  /** Noun used in generated prose; defaults to "unit". */
  readonly unitNoun?: string;
  readonly publication?: "published" | "source";
  readonly nodes: Readonly<Record<string, PipelineNodePresentation>>;
  readonly arrows?: Readonly<Record<string, readonly PipelineArrowGroup[]>>;
  readonly endpoints: readonly PipelineEndpointPresentation[];
  readonly terminals: readonly PipelineTerminalPresentation[];
  readonly goals?: Readonly<Record<string, { readonly name: string; readonly members?: readonly string[] }>>;
}

export interface PresentationValidationOptions {
  /** When supplied, recompile and prove the projection equals this sealed source. */
  readonly definition?: GraphDefinition;
  /** Requires definition so the engine can verify the exact seal and membership. */
  readonly goalManifest?: GoalManifest;
}

export interface BuildPipelineDiagramInput extends PresentationValidationOptions {
  readonly projection: GraphDisplayProjection;
  readonly presentation: PipelinePresentation;
  readonly historical?: boolean;
}

export interface PipelineDiagramMetadata {
  readonly schemaVersion: typeof PIPELINE_DIAGRAM_SCHEMA_VERSION;
  readonly graph: GraphDefinitionRef;
  readonly mode: "static";
  readonly presentationDigest: string;
  readonly unclaimedTerminals: readonly TerminalOutcome[];
}
