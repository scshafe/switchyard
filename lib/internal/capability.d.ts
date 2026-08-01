/** Capture a capability method once without invoking accessors or retaining a mutable code pointer. */
export declare function captureCapabilityRecord(target: unknown, allowedKeys: readonly string[], requiredKeys: readonly string[], label: string): Readonly<Record<string, unknown>>;
export declare function captureDenseArrayItems(value: unknown, label: string): readonly unknown[];
export declare function captureCapabilityDataProperty(target: unknown, key: string, label: string): unknown;
export declare function captureCapabilityMethod(target: unknown, key: string, label: string): (...args: any[]) => any;
