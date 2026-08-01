// prompt/compiler.ts — compilePromptStack: deterministic, digest-pinned
// compilation of a prompt stack into an ordered directive list + system prompt.
//
// PROMOTED from inbox-pipeline/src/prompts/compiler.ts (the ref-resolution
// rules with digest + kind checks, the unreferenced-component rejection, the
// "Trusted <kind>:" component labels, the numbered systemPrompt join, and the
// promptDigest pin over {compilerVersion, contractId, promptStack, persona,
// componentRefs, directives}) DE-ZOD-ED to hand-written LOUD validators.
// CHANGES in the promotion:
//   - the CODE-OWNED text (safety / task / output) is an explicit validated
//     input ({@link CodeOwnedPromptContract} from HOST CODE) instead of the
//     inbox's in-module record keyed by a domain enum — the engine stays
//     domain-free while the OWNERSHIP boundary is unchanged: safety text is
//     ALWAYS emitted FIRST and the output-contract line ALWAYS LAST, outside
//     and around the operator-composable components (components can add
//     emphasis, never remove policy, enable tools, or change the result
//     schema);
//   - the inbox specialistProfile directive arm is dropped with the persona
//     field (see prompt/contracts.ts) — for personas without a profile the
//     directive list, systemPrompt, and promptDigest are byte-identical to the
//     inbox compiler's output (same compilerVersion "prompt-compiler.v1");
//   - directives minimum is 3 (safety>=1 + task + output) instead of the inbox
//     5 (its safety block was fixed at 3 lines).
//
// STANDALONE: relative imports only (no npm deps, no zod).
import { digest } from "../contracts/digest.js";
import { validateContractId } from "../contracts/artifact.js";
import { assertPlainObject, assertSha256Hex, assertStrictKeys, assertVersionedRef, typeName, truncate } from "../internal/guards.js";
import { deepFrozenClone } from "../internal/evidence.js";
import { MAX_PROMPT_DIRECTIVE_LENGTH, validateCodeOwnedPromptContract, validatePersonaDefinition, validatePromptComponent, validatePromptStackDefinition } from "./contracts.js";
export const COMPILED_PROMPT_SCHEMA_VERSION = "compiled-prompt.v1";
/** Kept "prompt-compiler.v1": the algorithm is the inbox one (see header). */
export const PROMPT_COMPILER_VERSION = "prompt-compiler.v1";
export const MAX_COMPILED_COMPONENT_REFS = 112; // 32 persona + 32 rules + 32 focuses + 16 styles
export const MAX_COMPILED_DIRECTIVES = 128;
export const MIN_COMPILED_DIRECTIVES = 3; // safety >= 1, task, output
export const MAX_SYSTEM_PROMPT_LENGTH = 64_000;
/** The promoted "Trusted <kind>:" labels for operator-composable directives. */
const COMPONENT_LABELS = {
    persona_trait: "Trusted persona trait",
    decision_rule: "Trusted decision rule",
    domain_focus: "Trusted domain focus",
    response_style: "Trusted response style"
};
function referenceKey(reference) {
    return `${reference.id} ${reference.version}`;
}
function componentCatalog(componentsRaw) {
    const catalog = new Map();
    for (const raw of componentsRaw) {
        const component = validatePromptComponent(raw);
        const key = referenceKey(component);
        if (catalog.has(key)) {
            throw new Error(`Duplicate prompt component definition: ${component.id}@${component.version}`);
        }
        catalog.set(key, component);
    }
    return catalog;
}
/** Promoted resolution: existence + digest match + expected kind, LOUD. */
function resolveComponents(references, expectedKind, catalog) {
    return references.map((reference) => {
        const component = catalog.get(referenceKey(reference));
        if (!component) {
            throw new Error(`Prompt component not found: ${reference.id}@${reference.version}`);
        }
        if (component.componentDigest !== reference.digest) {
            throw new Error(`Prompt component digest mismatch: ${reference.id}@${reference.version}`);
        }
        if (component.kind !== expectedKind) {
            throw new Error(`Prompt component ${component.id}@${component.version} must be ${expectedKind}, received ${component.kind}`);
        }
        return component;
    });
}
function componentDirective(component) {
    return `${COMPONENT_LABELS[component.kind]}: ${component.content}`;
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
export function compilePromptStack(input) {
    input = deepFrozenClone(input, "prompt compilation input");
    const contract = validateCodeOwnedPromptContract(input.contract);
    const stack = validatePromptStackDefinition(input.stack);
    const persona = validatePersonaDefinition(input.persona);
    if (stack.persona.id !== persona.id ||
        stack.persona.version !== persona.version ||
        stack.persona.digest !== persona.personaDigest) {
        throw new Error("Prompt stack persona reference does not match the supplied persona definition");
    }
    if (!Array.isArray(input.components)) {
        throw new Error(`compilePromptStack: components must be an array (got ${typeName(input.components)})`);
    }
    const catalog = componentCatalog(input.components);
    const personaComponents = resolveComponents(persona.componentRefs, "persona_trait", catalog);
    const ruleComponents = resolveComponents(stack.ruleRefs, "decision_rule", catalog);
    const focusComponents = resolveComponents(stack.focusRefs, "domain_focus", catalog);
    const styleComponents = resolveComponents(stack.styleRefs, "response_style", catalog);
    const resolved = [...personaComponents, ...ruleComponents, ...focusComponents, ...styleComponents];
    const suppliedKeys = new Set([...catalog.keys()]);
    const resolvedKeys = new Set(resolved.map(referenceKey));
    if (suppliedKeys.size !== resolvedKeys.size || [...suppliedKeys].some((key) => !resolvedKeys.has(key))) {
        throw new Error("Prompt compiler received unreferenced component definitions");
    }
    // THE ownership boundary: code-owned safety FIRST, code-owned output LAST.
    const directives = [
        ...contract.safety,
        contract.task,
        ...resolved.map(componentDirective),
        contract.output
    ];
    if (directives.length > MAX_COMPILED_DIRECTIVES) {
        throw new Error(`Compiled prompt exceeds ${MAX_COMPILED_DIRECTIVES} directives (got ${directives.length})`);
    }
    const systemPrompt = directives.map((directive, index) => `${index + 1}. ${directive}`).join("\n");
    if (systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
        throw new Error(`Compiled system prompt exceeds ${MAX_SYSTEM_PROMPT_LENGTH} chars (got ${systemPrompt.length})`);
    }
    const componentRefs = resolved.map((component) => ({
        id: component.id,
        version: component.version,
        digest: component.componentDigest
    }));
    const promptStack = { id: stack.id, version: stack.version, digest: stack.stackDigest };
    const personaRef = { id: persona.id, version: persona.version, digest: persona.personaDigest };
    const promptDigest = digest({
        compilerVersion: PROMPT_COMPILER_VERSION,
        contractId: contract.contractId,
        promptStack,
        persona: personaRef,
        componentRefs,
        directives
    });
    return {
        schemaVersion: COMPILED_PROMPT_SCHEMA_VERSION,
        compilerVersion: PROMPT_COMPILER_VERSION,
        contractId: contract.contractId,
        promptStack,
        persona: personaRef,
        componentRefs,
        directives,
        systemPrompt,
        promptDigest
    };
}
const COMPILED_PROMPT_KEYS = new Set([
    "schemaVersion",
    "compilerVersion",
    "contractId",
    "promptStack",
    "persona",
    "componentRefs",
    "directives",
    "systemPrompt",
    "promptDigest"
]);
/**
 * LOUD validator for a {@link CompiledPrompt}: full shape validation PLUS
 * promptDigest recompute and systemPrompt recompute — any tampering with the
 * directives, refs, or rendered prompt throws (the digest-pinned seal).
 */
export function validateCompiledPrompt(value) {
    const label = "compiled prompt";
    value = deepFrozenClone(value, label);
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, COMPILED_PROMPT_KEYS, label);
    if (raw.schemaVersion !== COMPILED_PROMPT_SCHEMA_VERSION) {
        throw new Error(`${label}: schemaVersion must be ${JSON.stringify(COMPILED_PROMPT_SCHEMA_VERSION)} (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`);
    }
    if (raw.compilerVersion !== PROMPT_COMPILER_VERSION) {
        throw new Error(`${label}: compilerVersion must be ${JSON.stringify(PROMPT_COMPILER_VERSION)} (got ${typeof raw.compilerVersion === "string" ? JSON.stringify(truncate(raw.compilerVersion)) : typeName(raw.compilerVersion)})`);
    }
    const contractId = validateContractId(raw.contractId, `${label}: contractId`);
    const promptStack = assertVersionedRef(raw.promptStack, `${label}: promptStack`);
    const persona = assertVersionedRef(raw.persona, `${label}: persona`);
    if (!Array.isArray(raw.componentRefs) || raw.componentRefs.length > MAX_COMPILED_COMPONENT_REFS) {
        throw new Error(`${label}: componentRefs must be an array of 0..${MAX_COMPILED_COMPONENT_REFS} (got ${Array.isArray(raw.componentRefs) ? raw.componentRefs.length : typeName(raw.componentRefs)})`);
    }
    const componentRefs = raw.componentRefs.map((refRaw, index) => assertVersionedRef(refRaw, `${label}: componentRefs[${index}]`));
    if (!Array.isArray(raw.directives) ||
        raw.directives.length < MIN_COMPILED_DIRECTIVES ||
        raw.directives.length > MAX_COMPILED_DIRECTIVES) {
        throw new Error(`${label}: directives must be an array of ${MIN_COMPILED_DIRECTIVES}..${MAX_COMPILED_DIRECTIVES} (got ${Array.isArray(raw.directives) ? raw.directives.length : typeName(raw.directives)})`);
    }
    const directives = raw.directives.map((directive, index) => {
        if (typeof directive !== "string" || directive.length < 1 || directive.length > MAX_PROMPT_DIRECTIVE_LENGTH) {
            throw new Error(`${label}: directives[${index}] must be a 1..${MAX_PROMPT_DIRECTIVE_LENGTH} char string (got ${typeof directive === "string" ? directive.length : typeName(directive)})`);
        }
        return directive;
    });
    if (typeof raw.systemPrompt !== "string" || raw.systemPrompt.length < 1 || raw.systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
        throw new Error(`${label}: systemPrompt must be a 1..${MAX_SYSTEM_PROMPT_LENGTH} char string (got ${typeName(raw.systemPrompt)})`);
    }
    const expectedSystemPrompt = directives.map((directive, index) => `${index + 1}. ${directive}`).join("\n");
    if (raw.systemPrompt !== expectedSystemPrompt) {
        throw new Error(`${label}: systemPrompt does not match the numbered join of directives (tampered rendering)`);
    }
    const sealed = assertSha256Hex(raw.promptDigest, `${label}: promptDigest`);
    const computed = digest({
        compilerVersion: PROMPT_COMPILER_VERSION,
        contractId,
        promptStack,
        persona,
        componentRefs,
        directives
    });
    if (sealed !== computed) {
        throw new Error(`${label} for ${contractId}: digest mismatch — sealed ${sealed} != computed ${computed}`);
    }
    return {
        schemaVersion: COMPILED_PROMPT_SCHEMA_VERSION,
        compilerVersion: PROMPT_COMPILER_VERSION,
        contractId,
        promptStack,
        persona,
        componentRefs,
        directives,
        systemPrompt: raw.systemPrompt,
        promptDigest: sealed
    };
}
