import {
  actionEnvelopeSchema,
  changeReceiptSchema,
  type ChangeReceipt,
  type DomainActionPlan,
} from '../core/contracts';
import type { InteractionTelemetryPort } from './telemetry';

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
  telemetry?: InteractionTelemetryPort;
}): ActionCommitResult<State> {
  const startTime = Date.now();
  const envelope = actionEnvelopeSchema.parse(input.envelope);
  const actionType = typeof (envelope.action as any)?.type === 'string' ? (envelope.action as any).type : 'action';

  input.telemetry?.onActionStart?.({
    workspaceId: envelope.workspaceId,
    actionId: envelope.actionId,
    actionType,
    timestamp: startTime,
  });

  try {
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

    input.telemetry?.onActionEnd?.({
      workspaceId: envelope.workspaceId,
      actionId: envelope.actionId,
      actionType,
      durationMs: Date.now() - startTime,
      success: true,
      revision,
    });

    return { state: result.nextState, revision, receipt };
  } catch (err) {
    input.telemetry?.onActionEnd?.({
      workspaceId: envelope.workspaceId,
      actionId: envelope.actionId,
      actionType,
      durationMs: Date.now() - startTime,
      success: false,
      error: err,
    });
    throw err;
  }
}

export interface BatchActionCommitResult<State> {
  state: State;
  revision: number;
  receipts: ChangeReceipt[];
}

/**
 * Execute multiple domain actions sequentially in a single transaction.
 * Advances revision per action while preserving atomic rollback if any action fails.
 */
export function planBatchActionCommit<State>(input: {
  state: State;
  currentRevision: number;
  envelopes: unknown[];
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
  telemetry?: InteractionTelemetryPort;
}): BatchActionCommitResult<State> {
  if (!Array.isArray(input.envelopes) || input.envelopes.length === 0) {
    return { state: input.state, revision: input.currentRevision, receipts: [] };
  }

  let currentState = input.state;
  let rev = input.currentRevision;
  const receipts: ChangeReceipt[] = [];

  for (const rawEnvelope of input.envelopes) {
    const res = planActionCommit({
      state: currentState,
      currentRevision: rev,
      envelope: rawEnvelope,
      plan: input.plan,
      telemetry: input.telemetry,
    });
    currentState = res.state;
    rev = res.revision;
    receipts.push(res.receipt);
  }

  return { state: currentState, revision: rev, receipts };
}
