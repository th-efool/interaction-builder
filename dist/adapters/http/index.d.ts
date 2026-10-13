import type { createInteractionHandlers } from '../../runtime/handlers';
type Handlers = ReturnType<typeof createInteractionHandlers>;
/**
 * Explicit route table (no dynamic imports from URL). `segments` = path after /api/interaction/v1.
 *   POST workspaces | GET workspaces/:id | POST workspaces/:id/actions | GET workspaces/:id/events?after=N
 *   POST workspaces/:id/messages | POST workspaces/:id/run | GET workspaces/:id/runs/active
 *   POST workspaces/:id/runs/:runId/cancel | GET workspaces/:id/proposals | POST workspaces/:id/proposals/:id/decide
 */
export declare function dispatchInteraction(request: Request, segments: string[], getOwner: () => Promise<string | null>, h: Handlers): Promise<Response>;
export {};
//# sourceMappingURL=index.d.ts.map