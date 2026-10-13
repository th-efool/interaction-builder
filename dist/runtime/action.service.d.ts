import { type ChangeReceipt, type DomainActionPlan } from '../core/contracts';
export interface ActionCommitResult<State> {
    state: State;
    revision: number;
    receipt: ChangeReceipt;
}
/**
 * Stateless commit boundary for domain adapters.
 *
 * Production repository transaction must call this planner while holding its
 * workspace row/CAS lock, then persist returned state, receipt, event, and
 * outbox entry in one transaction. This service intentionally owns no storage.
 */
export declare function planActionCommit<State>(input: {
    state: State;
    currentRevision: number;
    envelope: unknown;
    plan: (state: State, action: unknown, context: {
        actionId: string;
        workspaceId: string;
        expectedRevision: number;
        currentRevision: number;
        entityVersions: ReadonlyMap<string, number>;
    }) => DomainActionPlan<State>;
    entityVersions?: ReadonlyMap<string, number>;
}): ActionCommitResult<State>;
export interface BatchActionCommitResult<State> {
    state: State;
    revision: number;
    receipts: ChangeReceipt[];
}
/**
 * Execute multiple domain actions sequentially in a single transaction.
 * Advances revision per action while preserving atomic rollback if any action fails.
 */
export declare function planBatchActionCommit<State>(input: {
    state: State;
    currentRevision: number;
    envelopes: unknown[];
    plan: (state: State, action: unknown, context: {
        actionId: string;
        workspaceId: string;
        expectedRevision: number;
        currentRevision: number;
        entityVersions: ReadonlyMap<string, number>;
    }) => DomainActionPlan<State>;
}): BatchActionCommitResult<State>;
//# sourceMappingURL=action.service.d.ts.map