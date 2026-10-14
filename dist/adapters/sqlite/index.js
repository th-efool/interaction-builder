// src/runtime/repository.ts
import { createHash } from "node:crypto";
function canonicalize(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(canonicalize);
  const sortedObj = {};
  for (const key of Object.keys(val).sort()) {
    sortedObj[key] = canonicalize(val[key]);
  }
  return sortedObj;
}
function computePayloadHash(payload) {
  const json = JSON.stringify(canonicalize(payload));
  return createHash("sha256").update(json).digest("hex");
}

// src/core/contracts.ts
import { z } from "zod";
var entityRefSchema = z.strictObject({
  kind: z.string().min(1).max(80),
  id: z.string().min(1).max(200),
  version: z.number().int().nonnegative()
});
var changeReceiptSchema = z.strictObject({
  receiptId: z.string().uuid(),
  actionId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
  changed: z.array(entityRefSchema).max(100),
  undoable: z.boolean()
});
var messagePartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().max(32e3) }),
  z.strictObject({ type: z.literal("entity_ref"), entity: entityRefSchema, label: z.string().max(300) }),
  z.strictObject({ type: z.literal("activity"), status: z.enum(["queued", "running", "waiting", "done", "failed"]), text: z.string().max(500) }),
  z.strictObject({ type: z.literal("change_receipt"), receipt: changeReceiptSchema }),
  z.strictObject({ type: z.literal("warning"), text: z.string().max(2e3) })
]);
var interactionMessageSchema = z.strictObject({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(messagePartSchema).min(1).max(100),
  sequence: z.number().int().positive(),
  runId: z.string().uuid().nullable()
});
var interactionEventSchema = z.strictObject({
  protocolVersion: z.literal(1),
  eventId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: z.enum([
    "message.accepted",
    "message.updated",
    "workspace.committed",
    "run.changed",
    "job.changed",
    "proposal.created",
    "proposal.resolved"
  ]),
  revision: z.number().int().nonnegative().optional(),
  payload: z.unknown()
});
var actionEnvelopeSchema = z.strictObject({
  actionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  entityVersions: z.array(entityRefSchema).max(100),
  action: z.unknown()
});

// src/runtime/action.service.ts
function planActionCommit(input) {
  const startTime = Date.now();
  const envelope = actionEnvelopeSchema.parse(input.envelope);
  const actionType = typeof envelope.action?.type === "string" ? envelope.action.type : "action";
  input.telemetry?.onActionStart?.({
    workspaceId: envelope.workspaceId,
    actionId: envelope.actionId,
    actionType,
    timestamp: startTime
  });
  try {
    if (envelope.expectedRevision !== input.currentRevision) {
      throw new Error("STALE_WORKSPACE");
    }
    const entityVersions = new Map(envelope.entityVersions.map((item) => [item.id, item.version]));
    const result = input.plan(input.state, envelope.action, {
      actionId: envelope.actionId,
      workspaceId: envelope.workspaceId,
      expectedRevision: envelope.expectedRevision,
      currentRevision: input.currentRevision,
      entityVersions: input.entityVersions ?? entityVersions
    });
    const revision = input.currentRevision + 1;
    const receipt = changeReceiptSchema.parse({
      receiptId: crypto.randomUUID(),
      actionId: envelope.actionId,
      revision,
      summary: result.summary,
      changed: result.changed,
      undoable: result.undoable
    });
    input.telemetry?.onActionEnd?.({
      workspaceId: envelope.workspaceId,
      actionId: envelope.actionId,
      actionType,
      durationMs: Date.now() - startTime,
      success: true,
      revision
    });
    return { state: result.nextState, revision, receipt };
  } catch (err) {
    input.telemetry?.onActionEnd?.({
      workspaceId: envelope.workspaceId,
      actionId: envelope.actionId,
      actionType,
      durationMs: Date.now() - startTime,
      success: false,
      error: err
    });
    throw err;
  }
}

// src/adapters/sqlite/index.ts
var SQLITE_INIT_DDL = `
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
function mapWorkspace(row) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    domainId: row.domainId,
    domainVersion: Number(row.domainVersion),
    snapshot: typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot,
    revision: Number(row.revision),
    contextEpoch: Number(row.contextEpoch),
    sequence: Number(row.sequence),
    lifecycle: row.lifecycle,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}
function mapMessage(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    role: row.role,
    parts: typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts,
    sequence: Number(row.sequence),
    runId: row.runId ?? null,
    createdAt: new Date(row.createdAt)
  };
}
function mapRun(row) {
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
    updatedAt: new Date(row.updatedAt)
  };
}
function mapStep(row) {
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
    updatedAt: new Date(row.updatedAt)
  };
}
function mapProposal(row) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actionPayload: typeof row.actionPayload === "string" ? JSON.parse(row.actionPayload) : row.actionPayload,
    readSet: row.readSet ? JSON.parse(row.readSet) : null,
    summary: row.summary,
    state: row.state,
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
    decisionActor: row.decisionActor ?? null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}
function createSqliteInteractionRepository(driver) {
  let initPromise = null;
  const ensureInit = async () => {
    if (!initPromise) {
      initPromise = Promise.resolve(driver.exec(SQLITE_INIT_DDL));
    }
    return initPromise;
  };
  const runTx = async (fn) => {
    await ensureInit();
    if (driver.transaction) {
      return driver.transaction(fn);
    }
    return fn();
  };
  return {
    async appendMessage(input) {
      return runTx(async () => {
        const payload = { id: input.id, role: input.role, parts: input.parts, runId: input.runId ?? null };
        const now = (/* @__PURE__ */ new Date()).toISOString();
        if (input.requestId) {
          const hash = computePayloadHash(payload);
          const prior = await driver.query(
            `SELECT response, payloadHash FROM interaction_requests WHERE workspaceId = ? AND actorId = ? AND operation = 'appendMessage' AND requestId = ?`,
            [input.workspaceId, input.ownerId, input.requestId]
          );
          if (prior.length > 0) {
            if (prior[0].payloadHash !== hash) throw new Error("IDEMPOTENCY_MISMATCH");
            return JSON.parse(prior[0].response);
          }
        }
        const wsRows = await driver.query(
          `SELECT sequence, contextEpoch, revision FROM interaction_workspaces WHERE id = ? AND ownerId = ?`,
          [input.workspaceId, input.ownerId]
        );
        if (wsRows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
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
        let scheduledRun;
        if (input.scheduleRun !== false && input.role === "user") {
          const active = await driver.query(
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
              status: "queued",
              contextEpoch: ws.contextEpoch,
              observedRevision: ws.revision,
              cursor: nextSequence,
              fence: 0,
              createdAt: now,
              updatedAt: now
            });
          }
        }
        await driver.query(
          `UPDATE interaction_workspaces SET sequence = ?, updatedAt = ? WHERE id = ?`,
          [nextSequence, now, input.workspaceId]
        );
        const msgRes = await driver.query(`SELECT * FROM interaction_messages WHERE id = ?`, [input.id]);
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
      const args = [params.workspaceId];
      if (params.beforeSequence !== void 0) {
        sql += ` AND sequence < ?`;
        args.push(params.beforeSequence);
      }
      sql += ` ORDER BY sequence DESC LIMIT ?`;
      args.push(params.limit ?? 50);
      const rows = await driver.query(sql, args);
      return rows.reverse().map(mapMessage);
    },
    async createWorkspace(params) {
      await ensureInit();
      const existing = await driver.query(`SELECT * FROM interaction_workspaces WHERE id = ?`, [params.id]);
      if (existing.length > 0) {
        if (existing[0].ownerId !== params.ownerId) throw new Error("WORKSPACE_OWNER_MISMATCH");
        return mapWorkspace(existing[0]);
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await driver.query(
        `INSERT INTO interaction_workspaces (id, ownerId, domainId, domainVersion, snapshot, revision, contextEpoch, sequence, lifecycle, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'active', ?, ?)`,
        [params.id, params.ownerId, params.domainId, params.domainVersion, JSON.stringify(params.initialSnapshot), now, now]
      );
      const created = await driver.query(`SELECT * FROM interaction_workspaces WHERE id = ?`, [params.id]);
      return mapWorkspace(created[0]);
    },
    async loadWorkspace(params) {
      await ensureInit();
      const rows = await driver.query(
        `SELECT * FROM interaction_workspaces WHERE id = ? AND ownerId = ?`,
        [params.workspaceId, params.ownerId]
      );
      if (rows.length === 0) return null;
      return mapWorkspace(rows[0]);
    },
    async commitAction(input) {
      return runTx(async () => {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        if (input.requestId) {
          const hash = computePayloadHash(input.envelope);
          const prior = await driver.query(
            `SELECT response, payloadHash FROM interaction_requests WHERE workspaceId = ? AND actorId = ? AND operation = 'commitAction' AND requestId = ?`,
            [input.workspaceId, input.ownerId, input.requestId]
          );
          if (prior.length > 0) {
            if (prior[0].payloadHash !== hash) throw new Error("IDEMPOTENCY_MISMATCH");
            return JSON.parse(prior[0].response);
          }
        }
        const wsRows = await driver.query(
          `SELECT * FROM interaction_workspaces WHERE id = ? AND ownerId = ?`,
          [input.workspaceId, input.ownerId]
        );
        if (wsRows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
        const ws = wsRows[0];
        if (ws.lifecycle !== "active") throw new Error("WORKSPACE_NOT_ACTIVE");
        if (input.runFence) {
          const runRows = await driver.query(
            `SELECT * FROM interaction_runs WHERE id = ?`,
            [input.runFence.runId]
          );
          if (runRows.length === 0 || runRows[0].status === "canceled") {
            throw new Error("RUN_CANCELED");
          }
          const run = runRows[0];
          if (run.leaseToken !== input.runFence.leaseToken) throw new Error("FENCE_EXPIRED");
          if (run.leaseUntil && new Date(run.leaseUntil) < /* @__PURE__ */ new Date()) throw new Error("FENCE_EXPIRED");
        }
        if (Number(ws.revision) !== input.expectedRevision) throw new Error("STALE_WORKSPACE");
        const currentSnapshot = typeof ws.snapshot === "string" ? JSON.parse(ws.snapshot) : ws.snapshot;
        const commitResult = planActionCommit({
          state: currentSnapshot,
          currentRevision: Number(ws.revision),
          envelope: input.envelope,
          plan: input.plan
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
        if (input.outboxItems) {
          for (const item of input.outboxItems) {
            await driver.query(
              `INSERT OR IGNORE INTO interaction_outbox (id, workspaceId, kind, payload, dedupKey, status, attempts, dueAt, createdAt, updatedAt)
               VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
              [crypto.randomUUID(), input.workspaceId, item.kind, JSON.stringify(item.payload), item.dedupKey, now, now, now]
            );
          }
        }
        const successResponse = {
          state: commitResult.state,
          revision: commitResult.revision,
          sequence: nextSequence,
          receipt: commitResult.receipt
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
      const rows = await driver.query(
        `SELECT * FROM interaction_events WHERE workspaceId = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
        [params.workspaceId, after, limit]
      );
      return rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        sequence: Number(r.sequence),
        protocolVersion: Number(r.protocolVersion),
        type: r.type,
        revision: r.revision !== null ? Number(r.revision) : null,
        payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
        createdAt: new Date(r.createdAt)
      }));
    },
    async claimOutbox(options) {
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
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const runId = params.runId ?? crypto.randomUUID();
      await driver.query(
        `INSERT INTO interaction_runs (id, workspaceId, triggeringMessageId, status, contextEpoch, observedRevision, cursor, fence, createdAt, updatedAt)
         VALUES (?, ?, ?, 'queued', 0, ?, 0, 0, ?, ?)`,
        [runId, params.workspaceId, params.triggeringMessageId ?? null, params.observedRevision ?? 0, now, now]
      );
      const rows = await driver.query(`SELECT * FROM interaction_runs WHERE id = ?`, [runId]);
      return mapRun(rows[0]);
    },
    async claimRun(params) {
      await ensureInit();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const rows = await driver.query(
        `SELECT * FROM interaction_runs WHERE status = 'queued' OR (status = 'running' AND leaseUntil < ?) ORDER BY createdAt ASC LIMIT 1`,
        [now]
      );
      if (rows.length === 0) return null;
      const run = rows[0];
      const leaseUntil = new Date(Date.now() + params.leaseDurationMs).toISOString();
      await driver.query(
        `UPDATE interaction_runs SET status = 'running', leaseOwner = ?, leaseToken = ?, leaseUntil = ?, fence = fence + 1, updatedAt = ? WHERE id = ?`,
        [params.leaseOwner, params.leaseToken, leaseUntil, now, run.id]
      );
      const updated = await driver.query(`SELECT * FROM interaction_runs WHERE id = ?`, [run.id]);
      return mapRun(updated[0]);
    },
    async heartbeatRun(params) {
      await ensureInit();
      const leaseUntil = new Date(Date.now() + params.leaseDurationMs).toISOString();
      await driver.query(
        `UPDATE interaction_runs SET leaseUntil = ?, updatedAt = ? WHERE id = ? AND leaseToken = ? AND status = 'running'`,
        [leaseUntil, (/* @__PURE__ */ new Date()).toISOString(), params.runId, params.leaseToken]
      );
      return true;
    },
    async cancelRun(params) {
      await ensureInit();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await driver.query(
        `UPDATE interaction_runs SET status = 'canceled', fence = fence + 1, error = ?, updatedAt = ? WHERE id = ?`,
        [params.reason ?? "Canceled", now, params.runId]
      );
      const runRows = await driver.query(`SELECT * FROM interaction_runs WHERE id = ?`, [params.runId]);
      if (runRows.length > 0) {
        const run = mapRun(runRows[0]);
        const wsRows = await driver.query(`SELECT sequence FROM interaction_workspaces WHERE id = ?`, [run.workspaceId]);
        const nextSeq = (Number(wsRows[0]?.sequence) || 0) + 1;
        await driver.query(`UPDATE interaction_workspaces SET sequence = ?, updatedAt = ? WHERE id = ?`, [nextSeq, now, run.workspaceId]);
        await driver.query(
          `INSERT INTO interaction_events (id, workspaceId, sequence, protocolVersion, type, revision, payload, createdAt) VALUES (?, ?, ?, 1, 'run.changed', NULL, ?, ?)`,
          [crypto.randomUUID(), run.workspaceId, nextSeq, JSON.stringify({ run }), now]
        );
      }
      return true;
    },
    async completeRun(params) {
      await ensureInit();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await driver.query(
        `UPDATE interaction_runs SET status = 'completed', leaseOwner = NULL, leaseToken = NULL, leaseUntil = NULL, budgetActual = ?, updatedAt = ? WHERE id = ? AND leaseToken = ?`,
        [params.budgetActual ? JSON.stringify(params.budgetActual) : null, now, params.runId, params.leaseToken]
      );
      const runRows = await driver.query(`SELECT * FROM interaction_runs WHERE id = ?`, [params.runId]);
      if (runRows.length > 0) {
        const run = mapRun(runRows[0]);
        const wsRows = await driver.query(`SELECT sequence FROM interaction_workspaces WHERE id = ?`, [run.workspaceId]);
        const nextSeq = (Number(wsRows[0]?.sequence) || 0) + 1;
        await driver.query(`UPDATE interaction_workspaces SET sequence = ?, updatedAt = ? WHERE id = ?`, [nextSeq, now, run.workspaceId]);
        await driver.query(
          `INSERT INTO interaction_events (id, workspaceId, sequence, protocolVersion, type, revision, payload, createdAt) VALUES (?, ?, ?, 1, 'run.changed', NULL, ?, ?)`,
          [crypto.randomUUID(), run.workspaceId, nextSeq, JSON.stringify({ run, assistantMessageId: params.assistantMessageId ?? null }), now]
        );
      }
      return true;
    },
    async failRun(params) {
      await ensureInit();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await driver.query(
        `UPDATE interaction_runs SET status = 'failed', error = ?, leaseOwner = NULL, leaseToken = NULL, leaseUntil = NULL, updatedAt = ? WHERE id = ? AND leaseToken = ?`,
        [params.error, now, params.runId, params.leaseToken]
      );
      const runRows = await driver.query(`SELECT * FROM interaction_runs WHERE id = ?`, [params.runId]);
      if (runRows.length > 0) {
        const run = mapRun(runRows[0]);
        const wsRows = await driver.query(`SELECT sequence FROM interaction_workspaces WHERE id = ?`, [run.workspaceId]);
        const nextSeq = (Number(wsRows[0]?.sequence) || 0) + 1;
        await driver.query(`UPDATE interaction_workspaces SET sequence = ?, updatedAt = ? WHERE id = ?`, [nextSeq, now, run.workspaceId]);
        await driver.query(
          `INSERT INTO interaction_events (id, workspaceId, sequence, protocolVersion, type, revision, payload, createdAt) VALUES (?, ?, ?, 1, 'run.changed', NULL, ?, ?)`,
          [crypto.randomUUID(), run.workspaceId, nextSeq, JSON.stringify({ run, error: params.error }), now]
        );
      }
      return true;
    },
    async getRun(params) {
      await ensureInit();
      const rows = await driver.query(`SELECT * FROM interaction_runs WHERE id = ?`, [params.runId]);
      if (rows.length === 0) return null;
      return mapRun(rows[0]);
    },
    async getActiveRun(params) {
      await ensureInit();
      const rows = await driver.query(
        `SELECT * FROM interaction_runs WHERE workspaceId = ? AND status IN ('queued', 'running') LIMIT 1`,
        [params.workspaceId]
      );
      if (rows.length === 0) return null;
      return mapRun(rows[0]);
    },
    async recordStep(params) {
      await ensureInit();
      const now = (/* @__PURE__ */ new Date()).toISOString();
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
          now
        ]
      );
      const rows = await driver.query(`SELECT * FROM interaction_steps WHERE id = ?`, [stepId]);
      return mapStep(rows[0]);
    },
    async listSteps(params) {
      await ensureInit();
      const rows = await driver.query(
        `SELECT * FROM interaction_steps WHERE runId = ? ORDER BY ordinal ASC`,
        [params.runId]
      );
      return rows.map(mapStep);
    },
    async createProposal(params) {
      await ensureInit();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const id = params.id ?? crypto.randomUUID();
      await driver.query(
        `INSERT INTO interaction_proposals (id, workspaceId, actionPayload, readSet, summary, state, expiresAt, decisionActor, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`,
        [id, params.workspaceId, JSON.stringify(params.actionPayload), params.readSet ? JSON.stringify(params.readSet) : null, params.summary, params.expiresAt?.toISOString() ?? null, now, now]
      );
      const rows = await driver.query(`SELECT * FROM interaction_proposals WHERE id = ?`, [id]);
      return mapProposal(rows[0]);
    },
    async resolveProposal(params) {
      await ensureInit();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await driver.query(
        `UPDATE interaction_proposals SET state = ?, decisionActor = ?, updatedAt = ? WHERE id = ? AND workspaceId = ?`,
        [params.decision, params.decisionActor, now, params.proposalId, params.workspaceId]
      );
      const rows = await driver.query(`SELECT * FROM interaction_proposals WHERE id = ?`, [params.proposalId]);
      return mapProposal(rows[0]);
    },
    async getProposal(params) {
      await ensureInit();
      const rows = await driver.query(
        `SELECT * FROM interaction_proposals WHERE id = ? AND workspaceId = ?`,
        [params.proposalId, params.workspaceId]
      );
      if (rows.length === 0) return null;
      return mapProposal(rows[0]);
    },
    async listProposals(params) {
      await ensureInit();
      let sql = `SELECT * FROM interaction_proposals WHERE workspaceId = ?`;
      const args = [params.workspaceId];
      if (params.state) {
        sql += ` AND state = ?`;
        args.push(params.state);
      }
      sql += ` ORDER BY createdAt DESC`;
      const rows = await driver.query(sql, args);
      return rows.map(mapProposal);
    }
  };
}
export {
  SQLITE_INIT_DDL,
  createSqliteInteractionRepository
};
//# sourceMappingURL=index.js.map
