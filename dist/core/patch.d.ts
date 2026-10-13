/**
 * Lightweight, zero-dependency RFC 6902 JSON Patch generator and applicator.
 * Enables transmitting minimal state deltas over HTTP/SSE instead of full state snapshots.
 */
export interface JsonPatchOperation {
    op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
    path: string;
    value?: unknown;
    from?: string;
}
export type JsonPatch = JsonPatchOperation[];
/**
 * Apply RFC 6902 JSON patch operations immutably to a document.
 */
export declare function applyJsonPatch<T>(doc: T, patch: JsonPatch): T;
/**
 * Generate minimal RFC 6902 JSON patch operations comparing two plain documents.
 */
export declare function generateJsonPatch(prev: unknown, next: unknown, basePath?: string): JsonPatch;
//# sourceMappingURL=patch.d.ts.map