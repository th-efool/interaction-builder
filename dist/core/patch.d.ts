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
/**
 * Resolves a JSON Pointer on a document to its target value.
 * Returns undefined if path does not exist.
 */
export declare function getValueByPointer(doc: unknown, path: string): unknown;
/**
 * Computes the inverse of an RFC 6902 JSON patch against the document state before the patch was applied.
 * Applying the inverse patch to the modified document restores the original document state.
 */
export declare function invertJsonPatch(doc: unknown, patch: JsonPatch): JsonPatch;
//# sourceMappingURL=patch.d.ts.map