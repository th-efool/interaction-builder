import type { ChangeReceipt, DomainActionPlan } from '../core/contracts';
export interface InteractionWorkspaceRecord<State = unknown> {
    id: string;
    ownerId: string;
    domainId: string;
    domainVersion: number;
    snapshot: State;
    revision: number;
    contextEpoch: number;
    sequence: number;
    lifecycle: 'active' | 'paused' | 'released' | 'archived';
    createdAt: Date;
    updatedAt: Date;
}
export interface InteractionEventRecord {
    id: string;
    workspaceId: string;
    sequence: number;
    protocolVersion: number;
    type: string;
    revision: number | null;
    payload: unknown;
    createdAt: Date;
}
export interface InteractionOutboxRecord {
    id: string;
    workspaceId: string;
    kind: string;
    payload: unknown;
    dedupKey: string;
    status: 'pending' | 'delivering' | 'delivered' | 'failed';
    attempts: number;
    dueAt: Date;
    leaseOwner: string | null;
    leaseToken: string | null;
    leaseUntil: Date | null;
    deliveredAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface InteractionRequestRecord {
    id: string;
    workspaceId: string;
    actorId: string;
    operation: string;
    requestId: string;
    payloadHash: string;
    response: unknown;
    createdAt: Date;
}
export interface ActionCommitInput<State> {
    workspaceId: string;
    ownerId: string;
    expectedRevision: number;
    envelope: unknown;
    plan: (state: State, action: unknown, context: {
        actionId: string;
        workspaceId: string;
        expectedRevision: number;
        currentRevision: number;
        entityVersions: ReadonlyMap<string, number>;
    }) => DomainActionPlan<State>;
    requestId?: string;
    runFence?: {
        runId: string;
        leaseToken: string;
    };
    outboxItems?: Array<{
        kind: string;
        payload: unknown;
        dedupKey: string;
    }>;
}
export interface ActionCommitSuccess<State> {
    state: State;
    revision: number;
    sequence: number;
    receipt: ChangeReceipt;
}
export interface ClaimOutboxOptions {
    leaseOwner: string;
    leaseToken: string;
    leaseDurationMs: number;
    limit?: number;
    now?: Date;
}
export interface InteractionMessageRecord {
    id: string;
    workspaceId: string;
    role: 'user' | 'assistant' | 'system';
    parts: unknown[];
    sequence: number;
    runId: string | null;
    createdAt: Date;
}
export interface AppendMessageInput {
    workspaceId: string;
    ownerId: string;
    /** Client-generated id, retained through retries. */
    id: string;
    role: 'user' | 'assistant' | 'system';
    parts: unknown[];
    runId?: string | null;
    requestId?: string;
    scheduleRun?: boolean;
}
export interface InteractionRunRecord {
    id: string;
    workspaceId: string;
    triggeringMessageId: string | null;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
    contextEpoch: number;
    observedRevision: number;
    cursor: number;
    fence: number;
    leaseOwner: string | null;
    leaseToken: string | null;
    leaseUntil: Date | null;
    deadline: Date | null;
    budgetReservation: unknown | null;
    budgetActual: unknown | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface InteractionStepRecord {
    id: string;
    runId: string;
    ordinal: number;
    kind: 'model_call' | 'tool_call';
    toolName: string | null;
    inputHash: string | null;
    inputPayload: unknown | null;
    state: 'started' | 'completed' | 'failed';
    result: unknown | null;
    error: string | null;
    effectKey: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface InteractionProposalRecord {
    id: string;
    workspaceId: string;
    actionPayload: unknown;
    readSet: unknown | null;
    summary: string;
    state: 'pending' | 'accepted' | 'rejected' | 'expired';
    expiresAt: Date | null;
    decisionActor: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface InteractionRepository {
    /** Atomically: persist message + advance workspace sequence + append `message.accepted` event. Idempotent by requestId. Optionally schedules run atomically. */
    appendMessage(input: AppendMessageInput): Promise<{
        message: InteractionMessageRecord;
        sequence: number;
        run?: InteractionRunRecord;
    }>;
    /** Newest-last page; `beforeSequence` for keyset pagination backwards. */
    listMessages(params: {
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
        budgetReservation?: unknown;
    }): Promise<InteractionRunRecord>;
    claimRun(params: {
        leaseOwner: string;
        leaseToken: string;
        leaseDurationMs: number;
        workspaceId?: string;
        supportedDomainIds?: string[];
        supportedDomainVersions?: number[];
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
export declare function computePayloadHash(payload: unknown): string;
export declare function deterministicUuid(seed: string): string;
//# sourceMappingURL=repository.d.ts.map