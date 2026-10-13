import {
  type ActionCommitInput,
  type AppendMessageInput,
  type InteractionMessageRecord,
  type ActionCommitSuccess,
  type ClaimOutboxOptions,
  type InteractionEventRecord,
  type InteractionOutboxRecord,
  type InteractionRepository,
  type InteractionRequestRecord,
  type InteractionWorkspaceRecord,
  type InteractionRunRecord,
  type InteractionStepRecord,
  type InteractionProposalRecord,
  computePayloadHash,
} from './repository';
import { planActionCommit } from './action.service';

export class MemoryInteractionRepository implements InteractionRepository {
  private workspaces = new Map<string, InteractionWorkspaceRecord<any>>();
  private events = new Map<string, InteractionEventRecord[]>();
  private outbox = new Map<string, InteractionOutboxRecord>();
  private requests = new Map<string, InteractionRequestRecord>();
  private messages = new Map<string, InteractionMessageRecord[]>();
  private runs = new Map<string, InteractionRunRecord>();
  private steps = new Map<string, InteractionStepRecord[]>();
  private proposals = new Map<string, InteractionProposalRecord>();

  async appendMessage(input: AppendMessageInput): Promise<{ message: InteractionMessageRecord; sequence: number; run?: InteractionRunRecord }> {
    const ws = this.workspaces.get(input.workspaceId);
    if (!ws || ws.ownerId !== input.ownerId) throw new Error('WORKSPACE_NOT_FOUND');
    const payload = { id: input.id, role: input.role, parts: input.parts, runId: input.runId ?? null };
    let key: string | null = null;
    if (input.requestId) {
      key = `${input.workspaceId}:${input.ownerId}:appendMessage:${input.requestId}`;
      const prior = this.requests.get(key);
      if (prior) {
        if (prior.payloadHash !== computePayloadHash(payload)) throw new Error('IDEMPOTENCY_MISMATCH');
        return structuredClone(prior.response) as { message: InteractionMessageRecord; sequence: number; run?: InteractionRunRecord };
      }
    }
    const sequence = ws.sequence + 1;
    ws.sequence = sequence;
    ws.updatedAt = new Date();

    const message: InteractionMessageRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      role: input.role,
      parts: structuredClone(input.parts),
      sequence,
      runId: input.runId ?? null,
      createdAt: new Date(),
    };

    const list = this.messages.get(input.workspaceId) ?? [];
    list.push(message);
    this.messages.set(input.workspaceId, list);

    const events = this.events.get(input.workspaceId) ?? [];
    events.push({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      sequence,
      protocolVersion: 1,
      type: 'message.accepted',
      revision: null,
      payload: { message: structuredClone(message) },
      createdAt: new Date(),
    });

    let scheduledRun: InteractionRunRecord | undefined;
    if (input.scheduleRun !== false && input.role === 'user') {
      const active = Array.from(this.runs.values()).find(
        r => r.workspaceId === input.workspaceId && (r.status === 'queued' || r.status === 'running')
      );
      if (active) {
        scheduledRun = structuredClone(active);
      } else {
        const runId = crypto.randomUUID();
        const runRecord: InteractionRunRecord = {
          id: runId,
          workspaceId: input.workspaceId,
          triggeringMessageId: input.id,
          status: 'queued',
          contextEpoch: ws.contextEpoch,
          observedRevision: ws.revision,
          cursor: sequence,
          fence: 0,
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
          deadline: null,
          budgetReservation: null,
          budgetActual: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.runs.set(runId, runRecord);
        this.outbox.set(`run:${runId}`, {
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          kind: 'assistant_run',
          payload: { runId, workspaceId: input.workspaceId },
          dedupKey: `run:${runId}`,
          status: 'pending',
          attempts: 0,
          dueAt: new Date(),
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
          deliveredAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        scheduledRun = structuredClone(runRecord);
      }
    }

    this.events.set(input.workspaceId, events);
    const result = { message: structuredClone(message), sequence, run: scheduledRun };
    if (key) {
      this.requests.set(key, {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        actorId: input.ownerId,
        operation: 'appendMessage',
        requestId: input.requestId!,
        payloadHash: computePayloadHash(payload),
        response: structuredClone(result),
        createdAt: new Date(),
      });
    }
    return result;
  }

  async listMessages(p: { workspaceId: string; ownerId: string; beforeSequence?: number; limit?: number }): Promise<InteractionMessageRecord[]> {
    const ws = this.workspaces.get(p.workspaceId);
    if (!ws || ws.ownerId !== p.ownerId) throw new Error('WORKSPACE_NOT_FOUND');
    const all = (this.messages.get(p.workspaceId) ?? []).filter(m => p.beforeSequence === undefined || m.sequence < p.beforeSequence);
    return all.slice(-(p.limit ?? 50)).map(m => structuredClone(m));
  }

  async createWorkspace<State>(params: {
    id: string;
    ownerId: string;
    domainId: string;
    domainVersion: number;
    initialSnapshot: State;
  }): Promise<InteractionWorkspaceRecord<State>> {
    const existing = this.workspaces.get(params.id);
    if (existing) {
      if (existing.ownerId !== params.ownerId) {
        throw new Error('WORKSPACE_OWNER_MISMATCH');
      }
      return structuredClone(existing) as InteractionWorkspaceRecord<State>;
    }

    const now = new Date();
    const record: InteractionWorkspaceRecord<State> = {
      id: params.id,
      ownerId: params.ownerId,
      domainId: params.domainId,
      domainVersion: params.domainVersion,
      snapshot: structuredClone(params.initialSnapshot),
      revision: 0,
      contextEpoch: 0,
      sequence: 0,
      lifecycle: 'active',
      createdAt: now,
      updatedAt: now,
    };

    this.workspaces.set(params.id, record);
    this.events.set(params.id, []);
    return structuredClone(record);
  }

  async loadWorkspace<State>(params: {
    workspaceId: string;
    ownerId: string;
  }): Promise<InteractionWorkspaceRecord<State> | null> {
    const workspace = this.workspaces.get(params.workspaceId);
    if (!workspace || workspace.ownerId !== params.ownerId) {
      return null;
    }
    return structuredClone(workspace) as InteractionWorkspaceRecord<State>;
  }

  async commitAction<State>(input: ActionCommitInput<State>): Promise<ActionCommitSuccess<State>> {
    let payloadHash: string | null = null;
    let requestKey: string | null = null;

    if (input.requestId) {
      payloadHash = computePayloadHash(input.envelope);
      requestKey = `${input.workspaceId}:${input.ownerId}:commitAction:${input.requestId}`;
      const existingRequest = this.requests.get(requestKey);
      if (existingRequest) {
        if (existingRequest.payloadHash !== payloadHash) {
          throw new Error('IDEMPOTENCY_MISMATCH');
        }
        return structuredClone(existingRequest.response) as ActionCommitSuccess<State>;
      }
    }

    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace || workspace.ownerId !== input.ownerId) {
      throw new Error('WORKSPACE_NOT_FOUND');
    }
    if (workspace.lifecycle !== 'active') {
      throw new Error('WORKSPACE_NOT_ACTIVE');
    }

    // Fencing check for assistant worker runs
    if (input.runFence) {
      const run = this.runs.get(input.runFence.runId);
      if (!run || run.status === 'canceled') throw new Error('RUN_CANCELED');
      if (run.leaseToken !== input.runFence.leaseToken) throw new Error('FENCE_EXPIRED');
      if (run.leaseUntil && run.leaseUntil < new Date()) throw new Error('FENCE_EXPIRED');
    }

    if (workspace.revision !== input.expectedRevision) {
      throw new Error('STALE_WORKSPACE');
    }

    const commitResult = planActionCommit({
      state: workspace.snapshot as State,
      currentRevision: workspace.revision,
      envelope: input.envelope,
      plan: input.plan,
    });

    const nextSequence = workspace.sequence + 1;
    const now = new Date();

    workspace.snapshot = structuredClone(commitResult.state);
    workspace.revision = commitResult.revision;
    workspace.contextEpoch += 1;
    workspace.sequence = nextSequence;
    workspace.updatedAt = now;

    const eventRecord: InteractionEventRecord = {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      sequence: nextSequence,
      protocolVersion: 1,
      type: 'workspace.committed',
      revision: commitResult.revision,
      payload: {
        receipt: commitResult.receipt,
        snapshot: structuredClone(commitResult.state),
      },
      createdAt: now,
    };

    const eventList = this.events.get(input.workspaceId) ?? [];
    eventList.push(eventRecord);
    this.events.set(input.workspaceId, eventList);

    if (input.outboxItems) {
      for (const item of input.outboxItems) {
        if (this.outbox.has(item.dedupKey)) continue;
        const outboxRecord: InteractionOutboxRecord = {
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          kind: item.kind,
          payload: structuredClone(item.payload),
          dedupKey: item.dedupKey,
          status: 'pending',
          attempts: 0,
          dueAt: now,
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
          deliveredAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.outbox.set(item.dedupKey, outboxRecord);
      }
    }

    const successResponse: ActionCommitSuccess<State> = {
      state: structuredClone(commitResult.state),
      revision: commitResult.revision,
      sequence: nextSequence,
      receipt: commitResult.receipt,
    };

    if (requestKey && payloadHash) {
      this.requests.set(requestKey, {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        actorId: input.ownerId,
        operation: 'commitAction',
        requestId: input.requestId!,
        payloadHash,
        response: structuredClone(successResponse),
        createdAt: new Date(),
      });
    }

    return successResponse;
  }

  async queryEvents(params: {
    workspaceId: string;
    ownerId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<InteractionEventRecord[]> {
    const workspace = this.workspaces.get(params.workspaceId);
    if (!workspace || workspace.ownerId !== params.ownerId) {
      throw new Error('WORKSPACE_NOT_FOUND');
    }

    const after = params.afterSequence ?? 0;
    const limit = params.limit ?? 100;
    const all = this.events.get(params.workspaceId) ?? [];

    return all
      .filter(event => event.sequence > after)
      .slice(0, limit)
      .map(event => structuredClone(event));
  }

  async claimOutbox(options: ClaimOutboxOptions): Promise<InteractionOutboxRecord[]> {
    const now = options.now ?? new Date();
    const limit = options.limit ?? 50;
    const claimed: InteractionOutboxRecord[] = [];

    for (const record of this.outbox.values()) {
      if (claimed.length >= limit) break;
      const isDue = record.dueAt <= now;
      const isPending = record.status === 'pending';
      const isExpiredLease =
        record.status === 'delivering' &&
        record.leaseUntil !== null &&
        record.leaseUntil < now;

      if (isDue && (isPending || isExpiredLease)) {
        record.status = 'delivering';
        record.leaseOwner = options.leaseOwner;
        record.leaseToken = options.leaseToken;
        record.leaseUntil = new Date(now.getTime() + options.leaseDurationMs);
        record.attempts += 1;
        record.updatedAt = now;
        claimed.push(structuredClone(record));
      }
    }

    return claimed;
  }

  async ackOutbox(params: {
    ids: string[];
    leaseToken: string;
    now?: Date;
  }): Promise<number> {
    const now = params.now ?? new Date();
    const idSet = new Set(params.ids);
    let ackedCount = 0;

    for (const record of this.outbox.values()) {
      if (
        idSet.has(record.id) &&
        record.status === 'delivering' &&
        record.leaseToken === params.leaseToken
      ) {
        record.status = 'delivered';
        record.deliveredAt = now;
        record.leaseOwner = null;
        record.leaseToken = null;
        record.leaseUntil = null;
        record.updatedAt = now;
        ackedCount += 1;
      }
    }

    return ackedCount;
  }

  async failOutbox(params: {
    id: string;
    leaseToken: string;
    retryInMs?: number;
    now?: Date;
  }): Promise<boolean> {
    const now = params.now ?? new Date();
    for (const record of this.outbox.values()) {
      if (
        record.id === params.id &&
        record.status === 'delivering' &&
        record.leaseToken === params.leaseToken
      ) {
        const backoff = params.retryInMs ?? 5_000 * Math.pow(2, record.attempts);
        record.status = 'pending';
        record.dueAt = new Date(now.getTime() + backoff);
        record.leaseOwner = null;
        record.leaseToken = null;
        record.leaseUntil = null;
        record.updatedAt = now;
        return true;
      }
    }
    return false;
  }

  /** Assistant Runs Lifecycle */
  async scheduleRun(params: {
    workspaceId: string;
    ownerId: string;
    triggeringMessageId?: string | null;
    observedRevision?: number;
    runId?: string;
  }): Promise<InteractionRunRecord> {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error('WORKSPACE_NOT_FOUND');

    const active = Array.from(this.runs.values()).find(
      r => r.workspaceId === params.workspaceId && (r.status === 'queued' || r.status === 'running')
    );
    if (active) return structuredClone(active);

    const runId = params.runId ?? crypto.randomUUID();
    const runRecord: InteractionRunRecord = {
      id: runId,
      workspaceId: params.workspaceId,
      triggeringMessageId: params.triggeringMessageId ?? null,
      status: 'queued',
      contextEpoch: ws.contextEpoch,
      observedRevision: params.observedRevision ?? ws.revision,
      cursor: ws.sequence,
      fence: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      deadline: null,
      budgetReservation: null,
      budgetActual: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.runs.set(runId, runRecord);
    this.outbox.set(`run:${runId}`, {
      id: crypto.randomUUID(),
      workspaceId: params.workspaceId,
      kind: 'assistant_run',
      payload: { runId, workspaceId: params.workspaceId },
      dedupKey: `run:${runId}`,
      status: 'pending',
      attempts: 0,
      dueAt: new Date(),
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      deliveredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const events = this.events.get(params.workspaceId) ?? [];
    events.push({
      id: crypto.randomUUID(),
      workspaceId: params.workspaceId,
      sequence: ws.sequence + 1,
      protocolVersion: 1,
      type: 'run.changed',
      revision: null,
      payload: { run: structuredClone(runRecord) },
      createdAt: new Date(),
    });
    ws.sequence += 1;
    this.events.set(params.workspaceId, events);

    return structuredClone(runRecord);
  }

  async claimRun(params: {
    leaseOwner: string;
    leaseToken: string;
    leaseDurationMs: number;
    workspaceId?: string;
    now?: Date;
  }): Promise<InteractionRunRecord | null> {
    const now = params.now ?? new Date();
    for (const run of this.runs.values()) {
      if (params.workspaceId && run.workspaceId !== params.workspaceId) continue;
      const isQueued = run.status === 'queued';
      const isExpiredRunning = run.status === 'running' && run.leaseUntil !== null && run.leaseUntil < now;
      if (isQueued || isExpiredRunning) {
        run.status = 'running';
        run.leaseOwner = params.leaseOwner;
        run.leaseToken = params.leaseToken;
        run.leaseUntil = new Date(now.getTime() + params.leaseDurationMs);
        run.fence += 1;
        run.updatedAt = now;

        const events = this.events.get(run.workspaceId) ?? [];
        events.push({
          id: crypto.randomUUID(),
          workspaceId: run.workspaceId,
          sequence: (this.workspaces.get(run.workspaceId)?.sequence ?? 0) + 1,
          protocolVersion: 1,
          type: 'run.changed',
          revision: null,
          payload: { run: structuredClone(run) },
          createdAt: now,
        });

        return structuredClone(run);
      }
    }
    return null;
  }

  async heartbeatRun(params: {
    runId: string;
    leaseToken: string;
    leaseDurationMs: number;
    now?: Date;
  }): Promise<boolean> {
    const now = params.now ?? new Date();
    const run = this.runs.get(params.runId);
    if (!run || run.leaseToken !== params.leaseToken || run.status !== 'running') return false;
    run.leaseUntil = new Date(now.getTime() + params.leaseDurationMs);
    run.updatedAt = now;
    return true;
  }

  async cancelRun(params: {
    runId: string;
    workspaceId: string;
    ownerId: string;
    reason?: string;
    now?: Date;
  }): Promise<boolean> {
    const now = params.now ?? new Date();
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error('WORKSPACE_NOT_FOUND');
    const run = this.runs.get(params.runId);
    if (!run || run.workspaceId !== params.workspaceId) return false;
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') return false;

    run.status = 'canceled';
    run.fence += 1;
    run.error = params.reason ?? 'Canceled by user';
    run.updatedAt = now;

    const events = this.events.get(params.workspaceId) ?? [];
    events.push({
      id: crypto.randomUUID(),
      workspaceId: params.workspaceId,
      sequence: ws.sequence + 1,
      protocolVersion: 1,
      type: 'run.changed',
      revision: null,
      payload: { run: structuredClone(run) },
      createdAt: now,
    });
    ws.sequence += 1;
    return true;
  }

  async completeRun(params: {
    runId: string;
    leaseToken: string;
    assistantMessageId?: string | null;
    budgetActual?: unknown;
    now?: Date;
  }): Promise<boolean> {
    const now = params.now ?? new Date();
    const run = this.runs.get(params.runId);
    if (!run || run.leaseToken !== params.leaseToken || run.status !== 'running') return false;

    run.status = 'completed';
    run.leaseOwner = null;
    run.leaseToken = null;
    run.leaseUntil = null;
    if (params.budgetActual) run.budgetActual = structuredClone(params.budgetActual);
    run.updatedAt = now;

    const ws = this.workspaces.get(run.workspaceId);
    if (ws) {
      const events = this.events.get(run.workspaceId) ?? [];
      events.push({
        id: crypto.randomUUID(),
        workspaceId: run.workspaceId,
        sequence: ws.sequence + 1,
        protocolVersion: 1,
        type: 'run.changed',
        revision: null,
        payload: { run: structuredClone(run), assistantMessageId: params.assistantMessageId ?? null },
        createdAt: now,
      });
      ws.sequence += 1;
    }

    return true;
  }

  async failRun(params: {
    runId: string;
    leaseToken: string;
    error: string;
    budgetActual?: unknown;
    now?: Date;
  }): Promise<boolean> {
    const now = params.now ?? new Date();
    const run = this.runs.get(params.runId);
    if (!run || run.leaseToken !== params.leaseToken || run.status !== 'running') return false;

    run.status = 'failed';
    run.error = params.error;
    run.leaseOwner = null;
    run.leaseToken = null;
    run.leaseUntil = null;
    if (params.budgetActual) run.budgetActual = structuredClone(params.budgetActual);
    run.updatedAt = now;

    const ws = this.workspaces.get(run.workspaceId);
    if (ws) {
      const events = this.events.get(run.workspaceId) ?? [];
      events.push({
        id: crypto.randomUUID(),
        workspaceId: run.workspaceId,
        sequence: ws.sequence + 1,
        protocolVersion: 1,
        type: 'run.changed',
        revision: null,
        payload: { run: structuredClone(run), error: params.error },
        createdAt: now,
      });
      ws.sequence += 1;
    }

    return true;
  }

  async getRun(params: {
    runId: string;
    workspaceId?: string;
  }): Promise<InteractionRunRecord | null> {
    const run = this.runs.get(params.runId);
    if (!run) return null;
    if (params.workspaceId && run.workspaceId !== params.workspaceId) return null;
    return structuredClone(run);
  }

  async getActiveRun(params: {
    workspaceId: string;
    ownerId: string;
  }): Promise<InteractionRunRecord | null> {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error('WORKSPACE_NOT_FOUND');
    const run = Array.from(this.runs.values()).find(
      r => r.workspaceId === params.workspaceId && (r.status === 'queued' || r.status === 'running')
    );
    return run ? structuredClone(run) : null;
  }

  /** Execution Journal (Steps) */
  async recordStep(params: {
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
  }): Promise<InteractionStepRecord> {
    const run = this.runs.get(params.runId);
    if (!run || run.leaseToken !== params.leaseToken) throw new Error('FENCE_EXPIRED');

    const steps = this.steps.get(params.runId) ?? [];
    const existingIdx = steps.findIndex(s => s.ordinal === params.ordinal);

    if (existingIdx !== -1) {
      const existing = steps[existingIdx];
      // Idempotency: if already completed, preserve result
      if (existing.state === 'completed' && params.state !== 'completed') {
        return structuredClone(existing);
      }
      existing.state = params.state;
      if (params.result !== undefined) existing.result = structuredClone(params.result);
      if (params.error !== undefined) existing.error = params.error;
      existing.updatedAt = new Date();
      return structuredClone(existing);
    }

    const stepRecord: InteractionStepRecord = {
      id: crypto.randomUUID(),
      runId: params.runId,
      ordinal: params.ordinal,
      kind: params.kind,
      toolName: params.toolName ?? null,
      inputHash: params.inputPayload ? computePayloadHash(params.inputPayload) : null,
      inputPayload: params.inputPayload ? structuredClone(params.inputPayload) : null,
      state: params.state,
      result: params.result ? structuredClone(params.result) : null,
      error: params.error ?? null,
      effectKey: params.effectKey ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    steps.push(stepRecord);
    this.steps.set(params.runId, steps);
    return structuredClone(stepRecord);
  }

  async listSteps(params: { runId: string }): Promise<InteractionStepRecord[]> {
    const steps = this.steps.get(params.runId) ?? [];
    return steps.sort((a, b) => a.ordinal - b.ordinal).map(s => structuredClone(s));
  }

  /** Proposals Lifecycle */
  async createProposal(params: {
    workspaceId: string;
    ownerId: string;
    id?: string;
    actionPayload: unknown;
    summary: string;
    readSet?: unknown;
    expiresAt?: Date;
  }): Promise<InteractionProposalRecord> {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error('WORKSPACE_NOT_FOUND');

    const proposalId = params.id ?? crypto.randomUUID();
    const proposal: InteractionProposalRecord = {
      id: proposalId,
      workspaceId: params.workspaceId,
      actionPayload: structuredClone(params.actionPayload),
      readSet: params.readSet ? structuredClone(params.readSet) : null,
      summary: params.summary,
      state: 'pending',
      expiresAt: params.expiresAt ?? null,
      decisionActor: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.proposals.set(proposalId, proposal);
    return structuredClone(proposal);
  }

  async resolveProposal(params: {
    proposalId: string;
    workspaceId: string;
    ownerId: string;
    decision: 'accepted' | 'rejected';
    decisionActor: string;
  }): Promise<InteractionProposalRecord> {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error('WORKSPACE_NOT_FOUND');

    const proposal = this.proposals.get(params.proposalId);
    if (!proposal || proposal.workspaceId !== params.workspaceId) throw new Error('PROPOSAL_NOT_FOUND');
    if (proposal.state !== 'pending') throw new Error('STALE_PROPOSAL');
    if (proposal.expiresAt && proposal.expiresAt < new Date()) {
      proposal.state = 'expired';
      throw new Error('PROPOSAL_EXPIRED');
    }

    proposal.state = params.decision;
    proposal.decisionActor = params.decisionActor;
    proposal.updatedAt = new Date();

    return structuredClone(proposal);
  }

  async getProposal(params: {
    proposalId: string;
    workspaceId: string;
    ownerId: string;
  }): Promise<InteractionProposalRecord | null> {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error('WORKSPACE_NOT_FOUND');
    const p = this.proposals.get(params.proposalId);
    return p && p.workspaceId === params.workspaceId ? structuredClone(p) : null;
  }

  async listProposals(params: {
    workspaceId: string;
    ownerId: string;
    state?: string;
  }): Promise<InteractionProposalRecord[]> {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error('WORKSPACE_NOT_FOUND');
    return Array.from(this.proposals.values())
      .filter(p => p.workspaceId === params.workspaceId && (!params.state || p.state === params.state))
      .map(p => structuredClone(p));
  }
}

export function createMemoryInteractionRepository(): InteractionRepository {
  return new MemoryInteractionRepository();
}
