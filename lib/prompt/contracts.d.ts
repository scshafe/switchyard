import { type ContractId } from "../contracts/artifact.js";
import { type VersionedDigestRef } from "../internal/guards.js";
export declare const PROMPT_COMPONENT_SCHEMA_VERSION = "prompt-component.v1";
export declare const PERSONA_DEFINITION_SCHEMA_VERSION = "persona-definition.v1";
export declare const PROMPT_STACK_SCHEMA_VERSION = "prompt-stack-definition.v1";
/** The four OPERATOR-COMPOSABLE component kinds (promoted verbatim). */
export declare const PROMPT_COMPONENT_KINDS: readonly ["persona_trait", "decision_rule", "domain_focus", "response_style"];
export type PromptComponentKind = (typeof PROMPT_COMPONENT_KINDS)[number];
export declare const MAX_PROMPT_COMPONENT_CONTENT = 2000;
export declare const MAX_PROMPT_DESCRIPTION = 500;
export declare const MAX_PERSONA_COMPONENTS = 32;
export declare const MAX_STACK_RULE_REFS = 32;
export declare const MAX_STACK_FOCUS_REFS = 32;
export declare const MAX_STACK_STYLE_REFS = 16;
/** Content-addressed `{ id, version, digest }` references (promoted shapes). */
export type PromptComponentRef = VersionedDigestRef;
export type PersonaRef = VersionedDigestRef;
export type PromptStackRef = VersionedDigestRef;
export interface PromptComponentInput {
    schemaVersion: typeof PROMPT_COMPONENT_SCHEMA_VERSION;
    id: string;
    version: number;
    kind: PromptComponentKind;
    content: string;
}
/** One digest-sealed, operator-composable prompt component. */
export interface PromptComponent extends PromptComponentInput {
    componentDigest: string;
}
/** Seal a component: validate LOUDLY, stamp `componentDigest = digest(base)`. */
export declare function createPromptComponent(input: unknown): PromptComponent;
/** LOUD validator for a SEALED component (digest recomputed — tampering throws). */
export declare function validatePromptComponent(value: unknown): PromptComponent;
/** Project a sealed component to its `{ id, version, digest }` ref. */
export declare function promptComponentRef(componentRaw: unknown): PromptComponentRef;
export interface PersonaDefinitionInput {
    schemaVersion: typeof PERSONA_DEFINITION_SCHEMA_VERSION;
    id: string;
    version: number;
    description: string;
    componentRefs: readonly PromptComponentRef[];
}
/** A digest-sealed persona: an ordered set of persona_trait component refs. */
export interface PersonaDefinition {
    schemaVersion: typeof PERSONA_DEFINITION_SCHEMA_VERSION;
    id: string;
    version: number;
    description: string;
    componentRefs: PromptComponentRef[];
    personaDigest: string;
}
export declare function createPersonaDefinition(input: unknown): PersonaDefinition;
export declare function validatePersonaDefinition(value: unknown): PersonaDefinition;
export declare function personaRef(personaRaw: unknown): PersonaRef;
export interface PromptStackDefinitionInput {
    schemaVersion: typeof PROMPT_STACK_SCHEMA_VERSION;
    id: string;
    version: number;
    description: string;
    persona: PersonaRef;
    ruleRefs: readonly PromptComponentRef[];
    focusRefs: readonly PromptComponentRef[];
    styleRefs: readonly PromptComponentRef[];
}
/**
 * A digest-sealed prompt stack: ONE persona ref plus ordered decision_rule /
 * domain_focus / response_style component refs (unique across all slots).
 */
export interface PromptStackDefinition {
    schemaVersion: typeof PROMPT_STACK_SCHEMA_VERSION;
    id: string;
    version: number;
    description: string;
    persona: PersonaRef;
    ruleRefs: PromptComponentRef[];
    focusRefs: PromptComponentRef[];
    styleRefs: PromptComponentRef[];
    stackDigest: string;
}
export declare function createPromptStackDefinition(input: unknown): PromptStackDefinition;
export declare function validatePromptStackDefinition(value: unknown): PromptStackDefinition;
export declare function promptStackRef(stackRaw: unknown): PromptStackRef;
export declare const MAX_PROMPT_SAFETY_LINES = 16;
export declare const MAX_PROMPT_DIRECTIVE_LENGTH = 2500;
/**
 * The CODE-OWNED half of a compiled prompt (promoted from the inbox
 * CODE_OWNED_PROMPT_CONTRACTS record): the safety policy lines, the task
 * statement, and the output-contract line. This value comes from HOST CODE —
 * it is never operator-composable data. The compiler places `safety` FIRST and
 * `output` LAST unconditionally: components may add emphasis between them but
 * can never remove policy, enable tools, or change the result schema.
 */
export interface CodeOwnedPromptContract {
    /** The prompt contract id this text implements, e.g. "email-classification.v1". */
    contractId: ContractId;
    safety: readonly string[];
    task: string;
    output: string;
}
/** LOUD validator for the code-owned contract; returns a fresh normalized copy. */
export declare function validateCodeOwnedPromptContract(value: unknown): CodeOwnedPromptContract;
