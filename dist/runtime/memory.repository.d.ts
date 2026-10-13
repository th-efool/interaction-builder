import { type ActionCommitInput, type AppendMessageInput, type InteractionMessageRecord, type ActionCommitSuccess, type ClaimOutboxOptions, type InteractionEventRecord, type InteractionOutboxRecord, type InteractionRepository, type InteractionWorkspaceRecord, type InteractionRunRecord, type InteractionStepRecord, type InteractionProposalRecord } from './repository';
export declare class MemoryInteractionRepository implements InteractionRepository {
    private workspaces;
    private events;
    private outbox;
    private requests;
    private messages;
    private runs;
    private steps;
    private proposals;
    appendMessage(input: AppendMessageInput): Promise<{
        message: InteractionMessageRecord;
        sequence: number;
        run?: InteractionRunRecord;
    }>;
    listMessages(p: {
        workspaceId: string;
        ownerId: string;
        beforeSequence?: number;
        limit?: number;
    }): Promise<InteractionMessageRecord[]>;
    createWorkspace<State>(params: {
        id: string;
        ownerId: string;
        domainId: string;
        domainVersion: number;
        initialSnapshot: State;
    }): Promise<InteractionWorkspaceRecord<State>>;
    loadWorkspace<State>(params: {
        workspaceId: string;
        ownerId: string;
    }): Promise<InteractionWorkspaceRecord<State> | null>;
    commitAction<State>(input: ActionCommitInput<State>): Promise<ActionCommitSuccess<State>>;
    queryEvents(params: {
        workspaceId: string;
        ownerId: string;
        afterSequence?: number;
        limit?: number;
    }): Promise<InteractionEventRecord[]>;
    claimOutbox(options: ClaimOutboxOptions): Promise<InteractionOutboxRecord[]>;
    ackOutbox(params: {
        ids: string[];
        leaseToken: string;
        now?: Date;
    }): Promise<number>;
    failOutbox(params: {
        id: string;
        leaseToken: string;
        retryInMs?: number;
        now?: Date;
    }): Promise<boolean>;
    /** Assistant Runs Lifecycle */
    scheduleRun(params: {
        workspaceId: string;
        ownerId: string;
        triggeringMessageId?: string | null;
        observedRevision?: number;
        runId?: string;
    }): Promise<InteractionRunRecord>;
    claimRun(params: {
        leaseOwner: string;
        leaseToken: string;
        leaseDurationMs: number;
        workspaceId?: string;
        now?: Date;
    }): Promise<InteractionRunRecord | null>;
    heartbeatRun(params: {
        runId: string;
        leaseToken: string;
        leaseDurationMs: number;
        now?: Date;
    }): Promise<boolean>;
    cancelRun(params: {
        runId: string;
        workspaceId: string;
        ownerId: string;
        reason?: string;
        now?: Date;
    }): Promise<boolean>;
    completeRun(params: {
        runId: string;
        leaseToken: string;
        assistantMessageId?: string | null;
        budgetActual?: unknown;
        now?: Date;
    }): Promise<boolean>;
    failRun(params: {
        runId: string;
        leaseToken: string;
        error: string;
        budgetActual?: unknown;
        now?: Date;
    }): Promise<boolean>;
    getRun(params: {
        runId: string;
        workspaceId?: string;
    }): Promise<InteractionRunRecord | null>;
    getActiveRun(params: {
        workspaceId: string;
        ownerId: string;
    }): Promise<InteractionRunRecord | null>;
    /** Execution Journal (Steps) */
    recordStep(params: {
        runId: string;
        leaseToken: string;
        ordinal: number;
        kind: 'model_call' | 'tool_call';
        toolName?: string;
        inputHash?: string;
        inputPayload?: unknown;
        state: 'started' | 'completed' | 'failed';
        result?: unknown;
        error?: string;
        effectKey?: string;
    }): Promise<InteractionStepRecord>;
    listSteps(params: {
        runId: string;
    }): Promise<InteractionStepRecord[]>;
    /** Proposals Lifecycle */
    createProposal(params: {
        workspaceId: string;
        ownerId: string;
        id?: string;
        actionPayload: unknown;
        summary: string;
        readSet?: unknown;
        expiresAt?: Date;
    }): Promise<InteractionProposalRecord>;
    resolveProposal(params: {
        proposalId: string;
        workspaceId: string;
        ownerId: string;
        decision: 'accepted' | 'rejected';
        decisionActor: string;
    }): Promise<InteractionProposalRecord>;
    getProposal(params: {
        proposalId: string;
        workspaceId: string;
        ownerId: string;
    }): Promise<InteractionProposalRecord | null>;
    listProposals(params: {
        workspaceId: string;
        ownerId: string;
        state?: string;
    }): Promise<InteractionProposalRecord[]>;
}
export declare function createMemoryInteractionRepository(): InteractionRepository;
//# sourceMappingURL=memory.repository.d.ts.map