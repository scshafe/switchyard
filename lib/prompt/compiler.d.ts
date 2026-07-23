import { type ContractId } from "../contracts/artifact.js";
import { type VersionedDigestRef } from "../internal/guards.js";
import { type CodeOwnedPromptContract, type PromptComponentRef } from "./contracts.js";
export declare const COMPILED_PROMPT_SCHEMA_VERSION = "compiled-prompt.v1";
/** Kept "prompt-compiler.v1": the algorithm is the inbox one (see header). */
export declare const PROMPT_COMPILER_VERSION = "prompt-compiler.v1";
export declare const MAX_COMPILED_COMPONENT_REFS = 112;
export declare const MAX_COMPILED_DIRECTIVES = 128;
export declare const MIN_COMPILED_DIRECTIVES = 3;
export declare const MAX_SYSTEM_PROMPT_LENGTH = 64000;
/** The digest-pinned compilation result. */
export interface CompiledPrompt {
    schemaVersion: typeof COMPILED_PROMPT_SCHEMA_VERSION;
    compilerVersion: typeof PROMPT_COMPILER_VERSION;
    contractId: ContractId;
    promptStack: VersionedDigestRef;
    persona: VersionedDigestRef;
    componentRefs: PromptComponentRef[];
    directives: string[];
    systemPrompt: string;
    promptDigest: string;
}
/**
 * Compile a prompt stack DETERMINISTICALLY into a digest-pinned
 * {@link CompiledPrompt}. Directive order is FIXED and code-owned:
 *
 *   1. contract.safety (CODE-OWNED, always first — the safety policy can never
 *      be displaced or diluted by operator components),
 *   2. contract.task,
 *   3. the resolved operator components (persona traits, then decision rules,
 *      then domain focuses, then response styles — each prefixed with its
 *      promoted "Trusted <kind>:" label),
 *   4. contract.output (CODE-OWNED, always last — the result schema line).
 *
 * Fails LOUD on: persona/stack digest mismatches, a stack whose persona ref
 * does not match the supplied persona, unresolved/mismatched/wrong-kind
 * component refs, and supplied-but-unreferenced components (nothing rides
 * along silently).
 */
export declare function compilePromptStack(input: {
    contract: CodeOwnedPromptContract;
    stack: unknown;
    persona: unknown;
    components: readonly unknown[];
}): CompiledPrompt;
/**
 * LOUD validator for a {@link CompiledPrompt}: full shape validation PLUS
 * promptDigest recompute and systemPrompt recompute — any tampering with the
 * directives, refs, or rendered prompt throws (the digest-pinned seal).
 */
export declare function validateCompiledPrompt(value: unknown): CompiledPrompt;
