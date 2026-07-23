import type { ContractId } from "./contracts/artifact.js";
import { type StageDescriptor, type StageDescriptorInput, type StageExecutable } from "./node.js";
export interface ContractValidationIssue {
    path?: string;
    message: string;
}
export type ContractValidationResult = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    issues: ContractValidationIssue[];
};
/**
 * The injected payload-validation port. `knows` gates catalog construction
 * (every referenced contract must be known); `validate` is called by the
 * executor around every stage execution.
 */
export interface ContractValidator {
    knows(contractId: ContractId): boolean;
    validate(contractId: ContractId, value: unknown): ContractValidationResult;
}
/** The ONE atomic registration unit: descriptor + executable, together. */
export interface StageRegistration {
    descriptor: StageDescriptorInput;
    executable: StageExecutable;
}
export declare class StageCatalog {
    #private;
    constructor(options: {
        contracts: ContractValidator;
        registrations?: readonly StageRegistration[];
    });
    /** The injected payload-validation port (the executor reads it from here). */
    get contracts(): ContractValidator;
    /**
     * THE atomic registration call (the parity fix): descriptor + executable
     * validated together, identity-matched, contract-checked, then stored in one
     * step — a descriptor can never be observed without its executable through
     * this path. Returns the normalized descriptor.
     */
    register(registration: StageRegistration): StageDescriptor;
    /**
     * ESCAPE HATCH for split registration (e.g. a host hydrating descriptors
     * from persisted catalog rows before wiring executables). A catalog holding
     * descriptor-only registrations FAILS {@link assertParity} and FAILS
     * compilePipeline for any pipeline referencing the stage until
     * {@link attachExecutable} completes the pair.
     */
    registerDescriptorOnly(descriptorRaw: StageDescriptorInput): StageDescriptor;
    /** Completes a {@link registerDescriptorOnly} pair. LOUD on unknown stage or double-attach. */
    attachExecutable(executableRaw: StageExecutable): void;
    hasStage(stageId: string, version: number): boolean;
    hasExecutable(stageId: string, version: number): boolean;
    /** Promoted LOUD resolution: throws `Unknown registered stage: id@version`. */
    resolveDescriptor(stageId: string, version: number): StageDescriptor;
    /** LOUD on unknown stage AND on descriptor-without-executable (parity). */
    resolveExecutable(stageId: string, version: number): StageExecutable;
    /** Promoted deterministic listing: sorted by stageId, then version. */
    list(): StageDescriptor[];
    /**
     * The parity assertion for split-registration escape hatches: throws if ANY
     * descriptor lacks its executable (executables cannot exist without a
     * descriptor by construction).
     */
    assertParity(): void;
}
