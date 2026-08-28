import { type GraphStore } from "./graph-store.js";
export interface GraphStoreConformanceDriver {
    readonly graphStore: GraphStore;
    close(): Promise<void>;
}
export interface GraphStoreConformanceFactoryContext {
    readonly backendName: string;
    readonly scenario: string;
}
export type GraphStoreConformanceDriverFactory = (context: GraphStoreConformanceFactoryContext) => GraphStoreConformanceDriver | Promise<GraphStoreConformanceDriver>;
export interface RegisterGraphStoreConformanceOptions {
    readonly backendName: string;
    readonly createDriver: GraphStoreConformanceDriverFactory;
}
/** Register the complete immutable-publication contract for one backend. */
export declare function registerGraphStoreConformanceTests(options: RegisterGraphStoreConformanceOptions): void;
