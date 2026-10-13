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
//# sourceMappingURL=action.service.d.ts.map