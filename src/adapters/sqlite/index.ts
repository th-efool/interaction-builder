import {
  type ActionCommitInput,
  type ActionCommitSuccess,
  type AppendMessageInput,
  type ClaimOutboxOptions,
  type InteractionEventRecord,
  type InteractionMessageRecord,
  type InteractionOutboxRecord,
  type InteractionProposalRecord,
  type InteractionRepository,
  type InteractionRunRecord,
  type InteractionStepRecord,
  type InteractionWorkspaceRecord,
  computePayloadHash,
} from '../../runtime/repository';
import { planActionCommit } from '../../runtime/action.service';

export interface SqliteDriver {
  exec(sql: string): void | Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] | Promise<T[]>;
  transaction?<T>(fn: () => T | Promise<T>): T | Promise<T>;
}

export const SQLITE_INIT_DDL = `
CREATE TABLE IF NOT EXISTS interaction_workspaces (
  id TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL,
  domainId TEXT NOT NULL,
  domainVersion INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  contextEpoch INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL DEFAULT 0,
  lifecycle TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_messages (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  runId TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_events (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  protocolVersion INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  revision INTEGER,
  payload TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_outbox (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  dedupKey TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  dueAt TEXT NOT NULL,
  leaseOwner TEXT,
  leaseToken TEXT,
  leaseUntil TEXT,
  deliveredAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_runs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  triggeringMessageId TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  contextEpoch INTEGER NOT NULL DEFAULT 0,
  observedRevision INTEGER NOT NULL DEFAULT 0,
  cursor INTEGER NOT NULL DEFAULT 0,
  fence INTEGER NOT NULL DEFAULT 0,
  leaseOwner TEXT,
  leaseToken TEXT,
  leaseUntil TEXT,
  deadline TEXT,
  budgetReservation TEXT,
  budgetActual TEXT,
  error TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_steps (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  toolName TEXT,
  inputHash TEXT,
  inputPayload TEXT,
  state TEXT NOT NULL,
  result TEXT,
  error TEXT,
  effectKey TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_proposals (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  actionPayload TEXT NOT NULL,
  readSet TEXT,
  summary TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  expiresAt TEXT,
  decisionActor TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_requests (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  actorId TEXT NOT NULL,
  operation TEXT NOT NULL,
  requestId TEXT NOT NULL,
  payloadHash TEXT NOT NULL,
  response TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
`;

function mapWorkspace<State>(row: any): InteractionWorkspaceRecord<State> {
  return {
    id: row.id,
    ownerId: row.ownerId,
    domainId: row.domainId,
    domainVersion: Number(row.domainVersion),
    snapshot: typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot,
    revision: Number(row.revision),
    contextEpoch: Number(row.contextEpoch),
    sequence: Number(row.sequence),
    lifecycle: row.lifecycle,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapMessage(row: any): InteractionMessageRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    role: row.role,
    parts: typeof row.parts === 'string' ? JSON.parse(row.parts) : row.parts,
    sequence: Number(row.sequence),
    runId: row.runId ?? null,
    createdAt: new Date(row.createdAt),
  };
}

function mapRun(row: any): InteractionRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    triggeringMessageId: row.triggeringMessageId ?? null,
    status: row.status,
    contextEpoch: Number(row.contextEpoch),
    observedRevision: Number(row.observedRevision),
    cursor: Number(row.cursor),
    fence: Number(row.fence),
    leaseOwner: row.leaseOwner ?? null,
    leaseToken: row.leaseToken ?? null,
    leaseUntil: row.leaseUntil ? new Date(row.leaseUntil) : null,
    deadline: row.deadline ? new Date(row.deadline) : null,
    budgetReservation: row.budgetReservation ? JSON.parse(row.budgetReservation) : null,
    budgetActual: row.budgetActual ? JSON.parse(row.budgetActual) : null,
    error: row.error ?? null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapStep(row: any): InteractionStepRecord {
  return {
    id: row.id,
    runId: row.runId,
    ordinal: Number(row.ordinal),
    kind: row.kind,
    toolName: row.toolName ?? null,
    inputHash: row.inputHash ?? null,
    inputPayload: row.inputPayload ? JSON.parse(row.inputPayload) : null,
    state: row.state,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error ?? null,
    effectKey: row.effectKey ?? null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapProposal(row: any): InteractionProposalRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actionPayload: typeof row.actionPayload === 'string' ? JSON.parse(row.actionPayload) : row.actionPayload,
    readSet: row.readSet ? JSON.parse(row.readSet) : null,
    summary: row.summary,
    state: row.state,
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
    decisionActor: row.decisionActor ?? null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function createSqliteInteractionRepository(driver: SqliteDriver): InteractionRepository {
  let initPromise: Promise<void> | null = null;
  const ensureInit = async () => {
    if (!initPromise) {
      initPromise = Promise.resolve(driver.exec(SQLITE_INIT_DDL));
    }
    return initPromise;
  };

  const runTx = async <T>(fn: () => Promise<T>): Promise<T> => {
    await ensureInit();
    if (driver.transaction) {
      return driver.transaction(fn);
    }
    return fn();
  };

  return {
    async appendMessage(input: AppendMessageInput) {
      return runTx(async () => {
        const payload = { id: input.id, role: input.role, parts: input.parts, runId: input.runId ?? null };
        const now = new Date().toISOString();

        if (input.requestId) {
          const hash = computePayloadHash(payload);
          const prior = await driver.query<any>(
            `SELECT response, payloadHash FROM interaction_requests WHERE workspaceId = ? AND actorId = ? AND operation = 'appendMessage' AND requestId = ?`,
            [input.workspaceId, input.ownerId, input.requestId]
          );
          if (prior.length > 0) {
            if (prior[0].payloadHash !== hash) throw new Error('IDEMPOTENCY_MISMATCH');
            return JSON.parse(prior[0].response);
          }
        }

        const wsRows = await driver.query<any>(
          `SELECT sequence, contextEpoch, revision FROM interaction_workspaces WHERE id = ? AND ownerId = ?`,
          [input.workspaceId, input.ownerId]
        );
        if (wsRows.length === 0) throw new Error('WORKSPACE_NOT_FOUND');
        const ws = wsRows[0];
        const nextSequence = Number(ws.sequence) + 1;

        await driver.query(
          `INSERT INTO interaction_messages (id, workspaceId, role, parts, sequence, runId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [input.id, input.workspaceId, input.role, JSON.stringify(input.parts), nextSequence, input.runId ?? null, now]
        );

        await driver.query(
          `INSERT INTO interaction_events (id, workspaceId, sequence, protocolVersion, type, revision, payload, createdAt) VALUES (?, ?, ?, 1, 'message.accepted', NULL, ?, ?)`,
          [crypto.randomUUID(), input.workspaceId, nextSequence, JSON.stringify({ message: { id: input.id, role: input.role, parts: input.parts, sequence: nextSequence, runId: input.runId ?? null, createdAt: new Date(now) } }), now]
        );

        let scheduledRun: InteractionRunRecord | undefined;
        if (input.scheduleRun !== false && input.role === 'user') {
          const active = await driver.query<any>(
            `SELECT * FROM interaction_runs WHERE workspaceId = ? AND status IN ('queued', 'running') LIMIT 1`,
            [input.workspaceId]
          );
          if (active.length > 0) {
            scheduledRun = mapRun(active[0]);
          } else {
            const runId = crypto.randomUUID();
            await driver.query(
              `INSERT INTO interaction_runs (id, workspaceId, triggeringMessageId, status, contextEpoch, observedRevision, cursor, fence, createdAt, updatedAt)
               VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?)`,
              [runId, input.workspaceId, input.id, Number(ws.contextEpoch), Number(ws.revision), nextSequence, now, now]
            );
            scheduledRun = mapRun({
              id: runId,
              workspaceId: input.workspaceId,
              triggeringMessageId: input.id,
              status: 'queued',
              contextEpoch: ws.contextEpoch,
              observedRevision: ws.revision,
              cursor: nextSequence,
              fence: 0,
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        await driver.query(
          `UPDATE interaction_workspaces SET sequence = ?, updatedAt = ? WHERE id = ?`,
          [nextSequence, now, input.workspaceId]
        );

        const msgRes = await driver.query<any>(`SELECT * FROM interaction_messages WHERE id = ?`, [input.id]);
        const responseData = { message: mapMessage(msgRes[0]), sequence: nextSequence, run: scheduledRun };

        if (input.requestId) {
          const hash = computePayloadHash(payload);
          await driver.query(
            `INSERT INTO interaction_requests (id, workspaceId, actorId, operation, requestId, payloadHash, response, createdAt) VALUES (?, ?, ?, 'appendMessage', ?, ?, ?, ?)`,
            [crypto.randomUUID(), input.workspaceId, input.ownerId, input.requestId, hash, JSON.stringify(responseData), now]
          );
        }

        return responseData;
      });
    },

    async listMessages(params) {
      await ensureInit();
      let sql = `SELECT * FROM interaction_messages WHERE workspaceId = ?`;
      const args: any[] = [params.workspaceId];
      if (params.beforeSequence !== undefined) {
        sql += ` AND sequence < ?`;
        args.push(params.beforeSequence);
      }
      sql += ` ORDER BY sequence DESC LIMIT ?`;
      args.push(params.limit ?? 50);

      const rows = await driver.query<any>(sql, args);
      return rows.reverse().map(mapMessage);
    },

    async createWorkspace<State>(params: {
      id: string;
      ownerId: string;
      domainId: string;
      domainVersion: number;
      initialSnapshot: State;
    }): Promise<InteractionWorkspaceRecord<State>> {
      await ensureInit();
      const existing = await driver.query<any>(`SELECT * FROM interaction_workspaces WHERE id = ?`, [params.id]);
      if (existing.length > 0) {
        if (existing[0].ownerId !== params.ownerId) throw new Error('WORKSPACE_OWNER_MISMATCH');
        return mapWorkspace<State>(existing[0]);
      }

      const now = new Date().toISOString();
      await driver.query(
        `INSERT INTO interaction_workspaces (id, ownerId, domainId, domainVersion, snapshot, revision, contextEpoch, sequence, lifecycle, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'active', ?, ?)`,
        [params.id, params.ownerId, params.domainId, params.domainVersion, JSON.stringify(params.initialSnapshot), now, now]
      );

      const created = await driver.query<any>(`SELECT * FROM interaction_workspaces WHERE id = ?`, [params.id]);
      return mapWorkspace<State>(created[0]);
    },

    async loadWorkspace<State>(params: {
      workspaceId: string;
      ownerId: string;
    }): Promise<InteractionWorkspaceRecord<State> | null> {
      await ensureInit();
      const rows = await driver.query<any>(
        `SELECT * FROM interaction_workspaces WHERE id = ? AND ownerId = ?`,
        [params.workspaceId, params.ownerId]
      );
      if (rows.length === 0) return null;
      return mapWorkspace<State>(rows[0]);
    },

    async commitAction<State>(input: ActionCommitInput<State>): Promise<ActionCommitSuccess<State>> {
      return runTx(async () => {
        const now = new Date().toISOString();

        if (input.requestId) {
          const hash = computePayloadHash(input.envelope);
          const prior = await driver.query<any>(
            `SELECT response, payloadHash FROM interaction_requests WHERE workspaceId = ? AND actorId = ? AND operation = 'commitAction' AND requestId = ?`,
            [input.workspaceId, input.ownerId, input.requestId]
          );
          if (prior.length > 0) {
            if (prior[0].payloadHash !== hash) throw new Error('IDEMPOTENCY_MISMATCH');
            return JSON.parse(prior[0].response);
          }
        }

        const wsRows = await driver.query<any>(
          `SELECT * FROM interaction_workspaces WHERE id = ? AND ownerId = ?`,
          [input.workspaceId, input.ownerId]
        );
        if (wsRows.length === 0) throw new Error('WORKSPACE_NOT_FOUND');
        const ws = wsRows[0];
        if (ws.lifecycle !== 'active') throw new Error('WORKSPACE_NOT_ACTIVE');

        if (Number(ws.revision) !== input.expectedRevision) throw new Error('STALE_WORKSPACE');

        const currentSnapshot = typeof ws.snapshot === 'string' ? JSON.parse(ws.snapshot) : ws.snapshot;
        const commitResult = planActionCommit({
          state: currentSnapshot as State,
          currentRevision: Number(ws.revision),
          envelope: input.envelope,
          plan: input.plan,
        });

        const nextSequence = Number(ws.sequence) + 1;

        await driver.query(
          `UPDATE interaction_workspaces SET snapshot = ?, revision = ?, contextEpoch = contextEpoch + 1, sequence = ?, updatedAt = ? WHERE id = ?`,
          [JSON.stringify(commitResult.state), commitResult.revision, nextSequence, now, input.workspaceId]
        );

        await driver.query(
          `INSERT INTO interaction_events (id, workspaceId, sequence, protocolVersion, type, revision, payload, createdAt) VALUES (?, ?, ?, 1, 'workspace.committed', ?, ?, ?)`,
          [crypto.randomUUID(), input.workspaceId, nextSequence, commitResult.revision, JSON.stringify({ receipt: commitResult.receipt, snapshot: commitResult.state }), now]
        );

        const successResponse: ActionCommitSuccess<State> = {
          state: commitResult.state,
          revision: commitResult.revision,
          sequence: nextSequence,
          receipt: commitResult.receipt,
        };

        if (input.requestId) {
          const hash = computePayloadHash(input.envelope);
          await driver.query(
            `INSERT INTO interaction_requests (id, workspaceId, actorId, operation, requestId, payloadHash, response, createdAt) VALUES (?, ?, ?, 'commitAction', ?, ?, ?, ?)`,
            [crypto.randomUUID(), input.workspaceId, input.ownerId, input.requestId, hash, JSON.stringify(successResponse), now]
          );
        }

        return successResponse;
      });
    },

    async queryEvents(params) {
      await ensureInit();
      const after = params.afterSequence ?? 0;
      const limit = params.limit ?? 100;
      const rows = await driver.query<any>(
        `SELECT * FROM interaction_events WHERE workspaceId = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
        [params.workspaceId, after, limit]
      );
      return rows.map(r => ({
        id: r.id,
        workspaceId: r.workspaceId,
        sequence: Number(r.sequence),
        protocolVersion: Number(r.protocolVersion),
        type: r.type,
        revision: r.revision !== null ? Number(r.revision) : null,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        createdAt: new Date(r.createdAt),
      }));
    },

    async claimOutbox(options: ClaimOutboxOptions) {
      return [];
    },

    async ackOutbox() {
      return 0;
    },

    async failOutbox() {
      return false;
    },

    async scheduleRun(params) {
      await ensureInit();
      const now = new Date().toISOString();
      const runId = params.runId ?? crypto.randomUUID();
      await driver.query(
        `INSERT INTO interaction_runs (id, workspaceId, triggeringMessageId, status, contextEpoch, observedRevision, cursor, fence, createdAt, updatedAt)
         VALUES (?, ?, ?, 'queued', 0, ?, 0, 0, ?, ?)`,
        [runId, params.workspaceId, params.triggeringMessageId ?? null, params.observedRevision ?? 0, now, now]
      );
      const rows = await driver.query<any>(`SELECT * FROM interaction_runs WHERE id = ?`, [runId]);
      return mapRun(rows[0]);
    },

    async claimRun(params) {
      await ensureInit();
      const now = new Date().toISOString();
      const rows = await driver.query<any>(
        `SELECT * FROM interaction_runs WHERE status = 'queued' ORDER BY createdAt ASC LIMIT 1`
      );
      if (rows.length === 0) return null;
      const run = rows[0];
      const leaseUntil = new Date(Date.now() + params.leaseDurationMs).toISOString();
      await driver.query(
        `UPDATE interaction_runs SET status = 'running', leaseOwner = ?, leaseToken = ?, leaseUntil = ?, fence = fence + 1, updatedAt = ? WHERE id = ?`,
        [params.leaseOwner, params.leaseToken, leaseUntil, now, run.id]
      );
      const updated = await driver.query<any>(`SELECT * FROM interaction_runs WHERE id = ?`, [run.id]);
      return mapRun(updated[0]);
    },

    async heartbeatRun(params) {
      await ensureInit();
      const leaseUntil = new Date(Date.now() + params.leaseDurationMs).toISOString();
      await driver.query(
        `UPDATE interaction_runs SET leaseUntil = ?, updatedAt = ? WHERE id = ? AND leaseToken = ? AND status = 'running'`,
        [leaseUntil, new Date().toISOString(), params.runId, params.leaseToken]
      );
      return true;
    },

    async cancelRun(params) {
      await ensureInit();
      await driver.query(
        `UPDATE interaction_runs SET status = 'canceled', error = ?, updatedAt = ? WHERE id = ?`,
        [params.reason ?? 'Canceled', new Date().toISOString(), params.runId]
      );
      return true;
    },

    async completeRun(params) {
      await ensureInit();
      await driver.query(
        `UPDATE interaction_runs SET status = 'completed', leaseOwner = NULL, leaseToken = NULL, leaseUntil = NULL, updatedAt = ? WHERE id = ? AND leaseToken = ?`,
        [new Date().toISOString(), params.runId, params.leaseToken]
      );
      return true;
    },

    async failRun(params) {
      await ensureInit();
      await driver.query(
        `UPDATE interaction_runs SET status = 'failed', error = ?, leaseOwner = NULL, leaseToken = NULL, leaseUntil = NULL, updatedAt = ? WHERE id = ? AND leaseToken = ?`,
        [params.error, new Date().toISOString(), params.runId, params.leaseToken]
      );
      return true;
    },

    async getRun(params) {
      await ensureInit();
      const rows = await driver.query<any>(`SELECT * FROM interaction_runs WHERE id = ?`, [params.runId]);
      if (rows.length === 0) return null;
      return mapRun(rows[0]);
    },

    async getActiveRun(params) {
      await ensureInit();
      const rows = await driver.query<any>(
        `SELECT * FROM interaction_runs WHERE workspaceId = ? AND status IN ('queued', 'running') LIMIT 1`,
        [params.workspaceId]
      );
      if (rows.length === 0) return null;
      return mapRun(rows[0]);
    },

    async recordStep(params) {
      await ensureInit();
      const now = new Date().toISOString();
      const stepId = crypto.randomUUID();
      await driver.query(
        `INSERT INTO interaction_steps (id, runId, ordinal, kind, toolName, inputHash, inputPayload, state, result, error, effectKey, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stepId,
          params.runId,
          params.ordinal,
          params.kind,
          params.toolName ?? null,
          params.inputHash ?? null,
          params.inputPayload ? JSON.stringify(params.inputPayload) : null,
          params.state,
          params.result ? JSON.stringify(params.result) : null,
          params.error ?? null,
          params.effectKey ?? null,
          now,
          now,
        ]
      );
      const rows = await driver.query<any>(`SELECT * FROM interaction_steps WHERE id = ?`, [stepId]);
      return mapStep(rows[0]);
    },

    async listSteps(params) {
      await ensureInit();
      const rows = await driver.query<any>(
        `SELECT * FROM interaction_steps WHERE runId = ? ORDER BY ordinal ASC`,
        [params.runId]
      );
      return rows.map(mapStep);
    },

    async createProposal(params) {
      await ensureInit();
      const now = new Date().toISOString();
      const id = params.id ?? crypto.randomUUID();
      await driver.query(
        `INSERT INTO interaction_proposals (id, workspaceId, actionPayload, readSet, summary, state, expiresAt, decisionActor, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
        [id, params.workspaceId, JSON.stringify(params.actionPayload), params.readSet ? JSON.stringify(params.readSet) : null, params.summary, params.expiresAt?.toISOString() ?? null, now, now]
      );
      const rows = await driver.query<any>(`SELECT * FROM interaction_proposals WHERE id = ?`, [id]);
      return mapProposal(rows[0]);
    },

    async resolveProposal(params) {
      await ensureInit();
      const now = new Date().toISOString();
      await driver.query(
        `UPDATE interaction_proposals SET state = ?, decisionActor = ?, updatedAt = ? WHERE id = ? AND workspaceId = ?`,
        [params.decision, params.decisionActor, now, params.proposalId, params.workspaceId]
      );
      const rows = await driver.query<any>(`SELECT * FROM interaction_proposals WHERE id = ?`, [params.proposalId]);
      return mapProposal(rows[0]);
    },

    async getProposal(params) {
      await ensureInit();
      const rows = await driver.query<any>(
        `SELECT * FROM interaction_proposals WHERE id = ? AND workspaceId = ?`,
        [params.proposalId, params.workspaceId]
      );
      if (rows.length === 0) return null;
      return mapProposal(rows[0]);
    },

    async listProposals(params) {
      await ensureInit();
      let sql = `SELECT * FROM interaction_proposals WHERE workspaceId = ?`;
      const args: any[] = [params.workspaceId];
      if (params.state) {
        sql += ` AND state = ?`;
        args.push(params.state);
      }
      sql += ` ORDER BY createdAt DESC`;
      const rows = await driver.query<any>(sql, args);
      return rows.map(mapProposal);
    },
  };
}
