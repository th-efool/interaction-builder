import { type DomainActionPlan } from '../core/contracts';
import type { InteractionRepository } from './repository';
/** Host-registered domain. Engine knows nothing about cohorts/agendas. */
export interface DomainDefinition<State = any> {
    id: string;
    version: number;
    /** Validate + build initial state from client bootstrap. */
    initialState(bootstrap: unknown): State;
    plan(state: State, action: unknown, ctx: {
        actionId: string;
        workspaceId: string;
        expectedRevision: number;
        currentRevision: number;
        entityVersions: ReadonlyMap<string, number>;
    }): DomainActionPlan<State>;
}
export interface InteractionHandlerDeps {
    repo: InteractionRepository;
    domains: ReadonlyMap<string, DomainDefinition>;
    onUserMessageAppended?: (ctx: {
        ownerId: string;
        workspaceId: string;
    }) => void | Promise<void>;
    runAssistant?: (ownerId: string, workspaceId: string) => Promise<HandlerResult>;
}
export interface HandlerResult {
    status: number;
    body: unknown;
}
/** Maps thrown errors to the public envelope; never leaks raw messages. */
export declare function toErrorResult(err: unknown, correlationId?: `${string}-${string}-${string}-${string}-${string}`): HandlerResult;
export declare function createInteractionHandlers(deps: InteractionHandlerDeps): {
    createWorkspace(ownerId: string, input: unknown): Promise<HandlerResult>;
    getWorkspace(ownerId: string, workspaceId: string): Promise<HandlerResult>;
    /** User chat turn: durable + idempotent. Atomically accepts message and schedules run intent. */
    sendMessage(ownerId: string, workspaceId: string, requestId: string | undefined, input: unknown): Promise<HandlerResult>;
    runAssistant(ownerId: string, workspaceId: string): Promise<HandlerResult>;
    cancelRun(ownerId: string, workspaceId: string, runId: string, input?: unknown): Promise<HandlerResult>;
    getActiveRun(ownerId: string, workspaceId: string): Promise<HandlerResult>;
    getRun(ownerId: string, workspaceId: string, runId: string): Promise<HandlerResult>;
    decideProposal(ownerId: string, workspaceId: string, proposalId: string, input: unknown): Promise<HandlerResult>;
    listProposals(ownerId: string, workspaceId: string, state?: string): Promise<HandlerResult>;
    listMessages(ownerId: string, workspaceId: string, beforeSequence?: number): Promise<HandlerResult>;
    /** Single action path shared by UI and model tool dispatch. */
    commitAction(ownerId: string, requestId: string | undefined, input: unknown): Promise<HandlerResult>;
    getEvents(ownerId: string, workspaceId: string, after?: number): Promise<HandlerResult>;
};
//# sourceMappingURL=handlers.d.ts.map