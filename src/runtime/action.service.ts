import {
  actionEnvelopeSchema,
  changeReceiptSchema,
  type ChangeReceipt,
  type DomainActionPlan,
} from '../core/contracts';

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
export function planActionCommit<State>(input: {
  state: State;
  currentRevision: number;
  envelope: unknown;
  plan: (
    state: State,
    action: unknown,
    context: {
      actionId: string;
      workspaceId: string;
      expectedRevision: number;
      currentRevision: number;
      entityVersions: ReadonlyMap<string, number>;
    }
  ) => DomainActionPlan<State>;
  entityVersions?: ReadonlyMap<string, number>;
}): ActionCommitResult<State> {
  const envelope = actionEnvelopeSchema.parse(input.envelope);
  if (envelope.expectedRevision !== input.currentRevision) {
    throw new Error('STALE_WORKSPACE');
  }
  const entityVersions = new Map(envelope.entityVersions.map(item => [item.id, item.version]));
  const result = input.plan(input.state, envelope.action, {
    actionId: envelope.actionId,
    workspaceId: envelope.workspaceId,
    expectedRevision: envelope.expectedRevision,
    currentRevision: input.currentRevision,
    entityVersions: input.entityVersions ?? entityVersions,
  });
  const revision = input.currentRevision + 1;
  const receipt = changeReceiptSchema.parse({
    receiptId: crypto.randomUUID(),
    actionId: envelope.actionId,
    revision,
    summary: result.summary,
    changed: result.changed,
    undoable: result.undoable,
  });
  return { state: result.nextState, revision, receipt };
}
