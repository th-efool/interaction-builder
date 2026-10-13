import type { createInteractionHandlers } from './handlers';
type Handlers = ReturnType<typeof createInteractionHandlers>;
export interface SseOptions {
    /** Poll cadence for new committed events. */
    pollMs?: number;
    /** Close after this long; client reconnects with Last-Event-ID (bounded streams). */
    maxMs?: number;
    heartbeatMs?: number;
    signal?: AbortSignal;
}
/**
 * Replay-to-live SSE. Only durable committed events are sent (id = persisted sequence).
 * Heartbeats are comments and never advance the cursor. Ownership checked before the stream opens.
 */
export declare function streamEvents(h: Handlers, ownerId: string, workspaceId: string, after: number, opts?: SseOptions): Promise<Response>;
export {};
//# sourceMappingURL=sse.d.ts.map