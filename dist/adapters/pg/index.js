// src/adapters/pg/index.ts
import pg from "pg";

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
  const envelope = actionEnvelopeSchema.parse(input.envelope);
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
  return { state: result.nextState, revision, receipt };
}

// src/adapters/pg/index.ts
var PgPool = pg?.Pool ?? pg?.default?.Pool ?? pg;
function mapWorkspace(row) {
  return {
    id: row.id,
    ownerId: row.ownerId,
    domainId: row.domainId,
    domainVersion: row.domainVersion,
    snapshot: typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot,
    revision: row.revision,
    contextEpoch: row.contextEpoch,
    sequence: row.sequence,
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
    sequence: row.sequence,
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
    contextEpoch: row.contextEpoch,
    observedRevision: row.observedRevision,
    cursor: row.cursor,
    fence: row.fence,
    leaseOwner: row.leaseOwner ?? null,
    leaseToken: row.leaseToken ?? null,
    leaseUntil: row.leaseUntil ? new Date(row.leaseUntil) : null,
    deadline: row.deadline ? new Date(row.deadline) : null,
    budgetReservation: row.budgetReservation ? typeof row.budgetReservation === "string" ? JSON.parse(row.budgetReservation) : row.budgetReservation : null,
    budgetActual: row.budgetActual ? typeof row.budgetActual === "string" ? JSON.parse(row.budgetActual) : row.budgetActual : null,
    error: row.error ?? null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}
function mapStep(row) {
  return {
    id: row.id,
    runId: row.runId,
    ordinal: row.ordinal,
    kind: row.kind,
    toolName: row.toolName ?? null,
    inputHash: row.inputHash ?? null,
    inputPayload: row.inputPayload ? typeof row.inputPayload === "string" ? JSON.parse(row.inputPayload) : row.inputPayload : null,
    state: row.state,
    result: row.result ? typeof row.result === "string" ? JSON.parse(row.result) : row.result : null,
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
    readSet: row.readSet ? typeof row.readSet === "string" ? JSON.parse(row.readSet) : row.readSet : null,
    summary: row.summary,
    state: row.state,
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
    decisionActor: row.decisionActor ?? null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}
function createPgInteractionRepository(options) {
  let pool = options.pool;
  if (!pool) {
    if (!options.connectionString) {
      throw new Error("Either pool or connectionString must be provided to createPgInteractionRepository");
    }
    pool = new PgPool({ connectionString: options.connectionString });
  }
  const effectivePool = pool;
  async function withTransaction(fn) {
    const client = await effectivePool.connect();
    try {
      await client.query("BEGIN");
      const res = await fn(client);
      await client.query("COMMIT");
      return res;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return {
    async appendMessage(input) {
      const payload = { id: input.id, role: input.role, parts: input.parts, runId: input.runId ?? null };
      return withTransaction(async (client) => {
        let hash = null;
        if (input.requestId) {
          hash = computePayloadHash(payload);
          const priorRes = await client.query(
            `SELECT "payloadHash", "response" FROM "interaction_requests"
             WHERE "workspaceId" = $1 AND "actorId" = $2 AND "operation" = 'appendMessage' AND "requestId" = $3`,
            [input.workspaceId, input.ownerId, input.requestId]
          );
          if (priorRes.rows.length > 0) {
            const prior = priorRes.rows[0];
            if (prior.payloadHash !== hash) throw new Error("IDEMPOTENCY_MISMATCH");
            const resp = typeof prior.response === "string" ? JSON.parse(prior.response) : prior.response;
            return resp;
          }
        }
        const wsRes = await client.query(
          `SELECT "id", "revision", "sequence", "contextEpoch" FROM "interaction_workspaces"
           WHERE "id" = $1 AND "ownerId" = $2 FOR UPDATE`,
          [input.workspaceId, input.ownerId]
        );
        if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
        const ws = wsRes.rows[0];
        const nextSequence = ws.sequence + 1;
        const now = /* @__PURE__ */ new Date();
        const msgRes = await client.query(
          `INSERT INTO "interaction_messages" ("id", "workspaceId", "role", "parts", "sequence", "runId", "createdAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [input.id, input.workspaceId, input.role, JSON.stringify(input.parts), nextSequence, input.runId ?? null, now]
        );
        const message = mapMessage(msgRes.rows[0]);
        await client.query(
          `INSERT INTO "interaction_events" ("id", "workspaceId", "sequence", "protocolVersion", "type", "revision", "payload", "createdAt")
           VALUES ($1, $2, $3, 1, 'message.accepted', NULL, $4, $5)`,
          [crypto.randomUUID(), input.workspaceId, nextSequence, JSON.stringify({ message }), now]
        );
        let scheduledRun;
        if (input.scheduleRun !== false && input.role === "user") {
          const activeRes = await client.query(
            `SELECT * FROM "interaction_runs"
             WHERE "workspaceId" = $1 AND "status" IN ('queued', 'running') LIMIT 1`,
            [input.workspaceId]
          );
          if (activeRes.rows.length > 0) {
            scheduledRun = mapRun(activeRes.rows[0]);
          } else {
            const runId = crypto.randomUUID();
            const runRes = await client.query(
              `INSERT INTO "interaction_runs" ("id", "workspaceId", "triggeringMessageId", "status", "contextEpoch", "observedRevision", "cursor", "fence", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, 'queued', $4, $5, $6, 0, $7, $7) RETURNING *`,
              [runId, input.workspaceId, input.id, ws.contextEpoch, ws.revision, nextSequence, now]
            );
            scheduledRun = mapRun(runRes.rows[0]);
            await client.query(
              `INSERT INTO "interaction_outbox" ("id", "workspaceId", "kind", "payload", "dedupKey", "status", "attempts", "dueAt", "createdAt", "updatedAt")
               VALUES ($1, $2, 'assistant_run', $3, $4, 'pending', 0, $5, $5, $5)
               ON CONFLICT ("dedupKey") DO NOTHING`,
              [crypto.randomUUID(), input.workspaceId, JSON.stringify({ runId, workspaceId: input.workspaceId }), `run:${runId}`, now]
            );
          }
        }
        await client.query(
          `UPDATE "interaction_workspaces" SET "sequence" = $1, "updatedAt" = $2 WHERE "id" = $3`,
          [nextSequence, now, input.workspaceId]
        );
        const responseData = { message, sequence: nextSequence, run: scheduledRun };
        if (input.requestId && hash) {
          await client.query(
            `INSERT INTO "interaction_requests" ("id", "workspaceId", "actorId", "operation", "requestId", "payloadHash", "response", "createdAt")
             VALUES ($1, $2, $3, 'appendMessage', $4, $5, $6, $7)`,
            [crypto.randomUUID(), input.workspaceId, input.ownerId, input.requestId, hash, JSON.stringify(responseData), now]
          );
        }
        return responseData;
      });
    },
    async listMessages(params) {
      const wsRes = await effectivePool.query(
        `SELECT "id" FROM "interaction_workspaces" WHERE "id" = $1 AND "ownerId" = $2`,
        [params.workspaceId, params.ownerId]
      );
      if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
      let query = `SELECT * FROM "interaction_messages" WHERE "workspaceId" = $1`;
      const queryParams = [params.workspaceId];
      if (params.beforeSequence !== void 0) {
        query += ` AND "sequence" < $2`;
        queryParams.push(params.beforeSequence);
      }
      query += ` ORDER BY "sequence" DESC LIMIT $${queryParams.length + 1}`;
      queryParams.push(params.limit ?? 50);
      const res = await effectivePool.query(query, queryParams);
      return res.rows.reverse().map(mapMessage);
    },
    async createWorkspace(params) {
      const existingRes = await effectivePool.query(
        `SELECT * FROM "interaction_workspaces" WHERE "id" = $1`,
        [params.id]
      );
      if (existingRes.rows.length > 0) {
        const row = existingRes.rows[0];
        if (row.ownerId !== params.ownerId) throw new Error("WORKSPACE_OWNER_MISMATCH");
        return mapWorkspace(row);
      }
      const now = /* @__PURE__ */ new Date();
      const res = await effectivePool.query(
        `INSERT INTO "interaction_workspaces" ("id", "ownerId", "domainId", "domainVersion", "snapshot", "revision", "contextEpoch", "sequence", "lifecycle", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 'active', $6, $6) RETURNING *`,
        [params.id, params.ownerId, params.domainId, params.domainVersion, JSON.stringify(params.initialSnapshot), now]
      );
      return mapWorkspace(res.rows[0]);
    },
    async loadWorkspace(params) {
      const res = await effectivePool.query(
        `SELECT * FROM "interaction_workspaces" WHERE "id" = $1 AND "ownerId" = $2`,
        [params.workspaceId, params.ownerId]
      );
      if (res.rows.length === 0) return null;
      return mapWorkspace(res.rows[0]);
    },
    async commitAction(input) {
      return withTransaction(async (client) => {
        let payloadHash = null;
        if (input.requestId) {
          payloadHash = computePayloadHash(input.envelope);
          const priorRes = await client.query(
            `SELECT "payloadHash", "response" FROM "interaction_requests"
             WHERE "workspaceId" = $1 AND "actorId" = $2 AND "operation" = 'commitAction' AND "requestId" = $3`,
            [input.workspaceId, input.ownerId, input.requestId]
          );
          if (priorRes.rows.length > 0) {
            const prior = priorRes.rows[0];
            if (prior.payloadHash !== payloadHash) throw new Error("IDEMPOTENCY_MISMATCH");
            const resp = typeof prior.response === "string" ? JSON.parse(prior.response) : prior.response;
            return resp;
          }
        }
        const wsRes = await client.query(
          `SELECT * FROM "interaction_workspaces" WHERE "id" = $1 AND "ownerId" = $2 FOR UPDATE`,
          [input.workspaceId, input.ownerId]
        );
        if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
        const ws = wsRes.rows[0];
        if (ws.lifecycle !== "active") throw new Error("WORKSPACE_NOT_ACTIVE");
        if (input.runFence) {
          const runRes = await client.query(
            `SELECT * FROM "interaction_runs" WHERE "id" = $1`,
            [input.runFence.runId]
          );
          if (runRes.rows.length === 0 || runRes.rows[0].status === "canceled") {
            throw new Error("RUN_CANCELED");
          }
          const run = runRes.rows[0];
          if (run.leaseToken !== input.runFence.leaseToken) throw new Error("FENCE_EXPIRED");
          if (run.leaseUntil && new Date(run.leaseUntil) < /* @__PURE__ */ new Date()) throw new Error("FENCE_EXPIRED");
        }
        if (ws.revision !== input.expectedRevision) throw new Error("STALE_WORKSPACE");
        const currentSnapshot = typeof ws.snapshot === "string" ? JSON.parse(ws.snapshot) : ws.snapshot;
        const commitResult = planActionCommit({
          state: currentSnapshot,
          currentRevision: ws.revision,
          envelope: input.envelope,
          plan: input.plan
        });
        const nextSequence = ws.sequence + 1;
        const now = /* @__PURE__ */ new Date();
        await client.query(
          `UPDATE "interaction_workspaces"
           SET "snapshot" = $1, "revision" = $2, "contextEpoch" = "contextEpoch" + 1, "sequence" = $3, "updatedAt" = $4
           WHERE "id" = $5`,
          [JSON.stringify(commitResult.state), commitResult.revision, nextSequence, now, input.workspaceId]
        );
        await client.query(
          `INSERT INTO "interaction_events" ("id", "workspaceId", "sequence", "protocolVersion", "type", "revision", "payload", "createdAt")
           VALUES ($1, $2, $3, 1, 'workspace.committed', $4, $5, $6)`,
          [
            crypto.randomUUID(),
            input.workspaceId,
            nextSequence,
            commitResult.revision,
            JSON.stringify({ receipt: commitResult.receipt, snapshot: commitResult.state }),
            now
          ]
        );
        if (input.outboxItems) {
          for (const item of input.outboxItems) {
            await client.query(
              `INSERT INTO "interaction_outbox" ("id", "workspaceId", "kind", "payload", "dedupKey", "status", "attempts", "dueAt", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $6, $6)
               ON CONFLICT ("dedupKey") DO NOTHING`,
              [crypto.randomUUID(), input.workspaceId, item.kind, JSON.stringify(item.payload), item.dedupKey, now]
            );
          }
        }
        const successResponse = {
          state: commitResult.state,
          revision: commitResult.revision,
          sequence: nextSequence,
          receipt: commitResult.receipt
        };
        if (input.requestId && payloadHash) {
          await client.query(
            `INSERT INTO "interaction_requests" ("id", "workspaceId", "actorId", "operation", "requestId", "payloadHash", "response", "createdAt")
             VALUES ($1, $2, $3, 'commitAction', $4, $5, $6, $7)`,
            [crypto.randomUUID(), input.workspaceId, input.ownerId, input.requestId, payloadHash, JSON.stringify(successResponse), now]
          );
        }
        return successResponse;
      });
    },
    async queryEvents(params) {
      const wsRes = await effectivePool.query(
        `SELECT "id" FROM "interaction_workspaces" WHERE "id" = $1 AND "ownerId" = $2`,
        [params.workspaceId, params.ownerId]
      );
      if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
      const after = params.afterSequence ?? 0;
      const limit = params.limit ?? 100;
      const res = await effectivePool.query(
        `SELECT * FROM "interaction_events" WHERE "workspaceId" = $1 AND "sequence" > $2 ORDER BY "sequence" ASC LIMIT $3`,
        [params.workspaceId, after, limit]
      );
      return res.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        sequence: row.sequence,
        protocolVersion: row.protocolVersion,
        type: row.type,
        revision: row.revision ?? null,
        payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
        createdAt: new Date(row.createdAt)
      }));
    },
    async claimOutbox(options2) {
      const now = options2.now ?? /* @__PURE__ */ new Date();
      const limit = options2.limit ?? 50;
      return withTransaction(async (client) => {
        const res = await client.query(
          `SELECT "id" FROM "interaction_outbox"
           WHERE "dueAt" <= $1 AND ("status" = 'pending' OR ("status" = 'delivering' AND "leaseUntil" < $1))
           ORDER BY "dueAt" ASC LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [now, limit]
        );
        if (res.rows.length === 0) return [];
        const ids = res.rows.map((r) => r.id);
        const leaseUntil = new Date(now.getTime() + options2.leaseDurationMs);
        const updatedRes = await client.query(
          `UPDATE "interaction_outbox"
           SET "status" = 'delivering', "leaseOwner" = $1, "leaseToken" = $2, "leaseUntil" = $3, "attempts" = "attempts" + 1, "updatedAt" = $4
           WHERE "id" = ANY($5::text[]) RETURNING *`,
          [options2.leaseOwner, options2.leaseToken, leaseUntil, now, ids]
        );
        return updatedRes.rows.map((row) => ({
          id: row.id,
          workspaceId: row.workspaceId,
          kind: row.kind,
          payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
          dedupKey: row.dedupKey,
          status: row.status,
          attempts: row.attempts,
          dueAt: new Date(row.dueAt),
          leaseOwner: row.leaseOwner,
          leaseToken: row.leaseToken,
          leaseUntil: row.leaseUntil ? new Date(row.leaseUntil) : null,
          deliveredAt: row.deliveredAt ? new Date(row.deliveredAt) : null,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt)
        }));
      });
    },
    async ackOutbox(params) {
      const now = params.now ?? /* @__PURE__ */ new Date();
      const res = await effectivePool.query(
        `UPDATE "interaction_outbox"
         SET "status" = 'delivered', "deliveredAt" = $1, "leaseOwner" = NULL, "leaseToken" = NULL, "leaseUntil" = NULL, "updatedAt" = $1
         WHERE "id" = ANY($2::text[]) AND "status" = 'delivering' AND "leaseToken" = $3`,
        [now, params.ids, params.leaseToken]
      );
      return res.rowCount ?? 0;
    },
    async failOutbox(params) {
      const now = params.now ?? /* @__PURE__ */ new Date();
      const res = await effectivePool.query(
        `UPDATE "interaction_outbox"
         SET "status" = 'pending', "dueAt" = $1, "leaseOwner" = NULL, "leaseToken" = NULL, "leaseUntil" = NULL, "updatedAt" = $2
         WHERE "id" = $3 AND "status" = 'delivering' AND "leaseToken" = $4`,
        [new Date(now.getTime() + (params.retryInMs ?? 5e3)), now, params.id, params.leaseToken]
      );
      return (res.rowCount ?? 0) > 0;
    },
    async scheduleRun(params) {
      return withTransaction(async (client) => {
        const wsRes = await client.query(
          `SELECT "id", "revision", "sequence", "contextEpoch" FROM "interaction_workspaces"
           WHERE "id" = $1 AND "ownerId" = $2 FOR UPDATE`,
          [params.workspaceId, params.ownerId]
        );
        if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
        const ws = wsRes.rows[0];
        const activeRes = await client.query(
          `SELECT * FROM "interaction_runs"
           WHERE "workspaceId" = $1 AND "status" IN ('queued', 'running') LIMIT 1`,
          [params.workspaceId]
        );
        if (activeRes.rows.length > 0) return mapRun(activeRes.rows[0]);
        const runId = params.runId ?? crypto.randomUUID();
        const now = /* @__PURE__ */ new Date();
        const runRes = await client.query(
          `INSERT INTO "interaction_runs" ("id", "workspaceId", "triggeringMessageId", "status", "contextEpoch", "observedRevision", "cursor", "fence", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, 'queued', $4, $5, $6, 0, $7, $7) RETURNING *`,
          [runId, params.workspaceId, params.triggeringMessageId ?? null, ws.contextEpoch, params.observedRevision ?? ws.revision, ws.sequence, now]
        );
        await client.query(
          `INSERT INTO "interaction_outbox" ("id", "workspaceId", "kind", "payload", "dedupKey", "status", "attempts", "dueAt", "createdAt", "updatedAt")
           VALUES ($1, $2, 'assistant_run', $3, $4, 'pending', 0, $5, $5, $5)
           ON CONFLICT ("dedupKey") DO NOTHING`,
          [crypto.randomUUID(), params.workspaceId, JSON.stringify({ runId, workspaceId: params.workspaceId }), `run:${runId}`, now]
        );
        const nextSequence = ws.sequence + 1;
        await client.query(
          `UPDATE "interaction_workspaces" SET "sequence" = $1, "updatedAt" = $2 WHERE "id" = $3`,
          [nextSequence, now, params.workspaceId]
        );
        const runRecord = mapRun(runRes.rows[0]);
        await client.query(
          `INSERT INTO "interaction_events" ("id", "workspaceId", "sequence", "protocolVersion", "type", "revision", "payload", "createdAt")
           VALUES ($1, $2, $3, 1, 'run.changed', NULL, $4, $5)`,
          [crypto.randomUUID(), params.workspaceId, nextSequence, JSON.stringify({ run: runRecord }), now]
        );
        return runRecord;
      });
    },
    async claimRun(params) {
      const now = params.now ?? /* @__PURE__ */ new Date();
      return withTransaction(async (client) => {
        let query = `SELECT "id", "workspaceId" FROM "interaction_runs"
                     WHERE ("status" = 'queued' OR ("status" = 'running' AND "leaseUntil" < $1))`;
        const queryParams = [now];
        if (params.workspaceId) {
          query += ` AND "workspaceId" = $2`;
          queryParams.push(params.workspaceId);
        }
        query += ` ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED`;
        const candRes = await client.query(query, queryParams);
        if (candRes.rows.length === 0) return null;
        const cand = candRes.rows[0];
        const leaseUntil = new Date(now.getTime() + params.leaseDurationMs);
        const updatedRes = await client.query(
          `UPDATE "interaction_runs"
           SET "status" = 'running', "leaseOwner" = $1, "leaseToken" = $2, "leaseUntil" = $3, "fence" = "fence" + 1, "updatedAt" = $4
           WHERE "id" = $5 RETURNING *`,
          [params.leaseOwner, params.leaseToken, leaseUntil, now, cand.id]
        );
        const runRecord = mapRun(updatedRes.rows[0]);
        const wsRes = await client.query(
          `UPDATE "interaction_workspaces" SET "sequence" = "sequence" + 1, "updatedAt" = $1 WHERE "id" = $2 RETURNING "sequence"`,
          [now, cand.workspaceId]
        );
        const sequence = wsRes.rows[0]?.sequence ?? 1;
        await client.query(
          `INSERT INTO "interaction_events" ("id", "workspaceId", "sequence", "protocolVersion", "type", "revision", "payload", "createdAt")
           VALUES ($1, $2, $3, 1, 'run.changed', NULL, $4, $5)`,
          [crypto.randomUUID(), cand.workspaceId, sequence, JSON.stringify({ run: runRecord }), now]
        );
        return runRecord;
      });
    },
    async heartbeatRun(params) {
      const now = params.now ?? /* @__PURE__ */ new Date();
      const leaseUntil = new Date(now.getTime() + params.leaseDurationMs);
      const res = await effectivePool.query(
        `UPDATE "interaction_runs" SET "leaseUntil" = $1, "updatedAt" = $2
         WHERE "id" = $3 AND "leaseToken" = $4 AND "status" = 'running'`,
        [leaseUntil, now, params.runId, params.leaseToken]
      );
      return (res.rowCount ?? 0) > 0;
    },
    async cancelRun(params) {
      const now = params.now ?? /* @__PURE__ */ new Date();
      return withTransaction(async (client) => {
        const wsRes = await client.query(
          `SELECT "id" FROM "interaction_workspaces" WHERE "id" = $1 AND "ownerId" = $2`,
          [params.workspaceId, params.ownerId]
        );
        if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
        const runRes = await client.query(
          `SELECT * FROM "interaction_runs" WHERE "id" = $1 AND "workspaceId" = $2 FOR UPDATE`,
          [params.runId, params.workspaceId]
        );
        if (runRes.rows.length === 0) return false;
        const current = runRes.rows[0];
        if (["completed", "failed", "canceled"].includes(current.status)) return false;
        const updatedRes = await client.query(
          `UPDATE "interaction_runs"
           SET "status" = 'canceled', "fence" = "fence" + 1, "error" = $1, "updatedAt" = $2
           WHERE "id" = $3 RETURNING *`,
          [params.reason ?? "Canceled by user", now, params.runId]
        );
        const runRecord = mapRun(updatedRes.rows[0]);
        const wsUpRes = await client.query(
          `UPDATE "interaction_workspaces" SET "sequence" = "sequence" + 1, "updatedAt" = $1 WHERE "id" = $2 RETURNING "sequence"`,
          [now, params.workspaceId]
        );
        const sequence = wsUpRes.rows[0]?.sequence ?? 1;
        await client.query(
          `INSERT INTO "interaction_events" ("id", "workspaceId", "sequence", "protocolVersion", "type", "revision", "payload", "createdAt")
           VALUES ($1, $2, $3, 1, 'run.changed', NULL, $4, $5)`,
          [crypto.randomUUID(), params.workspaceId, sequence, JSON.stringify({ run: runRecord }), now]
        );
        return true;
      });
    },
    async completeRun(params) {
      const now = params.now ?? /* @__PURE__ */ new Date();
      return withTransaction(async (client) => {
        const runRes = await client.query(
          `SELECT * FROM "interaction_runs" WHERE "id" = $1 AND "leaseToken" = $2 AND "status" = 'running' FOR UPDATE`,
          [params.runId, params.leaseToken]
        );
        if (runRes.rows.length === 0) return false;
        const updatedRes = await client.query(
          `UPDATE "interaction_runs"
           SET "status" = 'completed', "leaseOwner" = NULL, "leaseToken" = NULL, "leaseUntil" = NULL, "budgetActual" = $1, "updatedAt" = $2
           WHERE "id" = $3 RETURNING *`,
          [params.budgetActual ? JSON.stringify(params.budgetActual) : null, now, params.runId]
        );
        const runRecord = mapRun(updatedRes.rows[0]);
        const wsUpRes = await client.query(
          `UPDATE "interaction_workspaces" SET "sequence" = "sequence" + 1, "updatedAt" = $1 WHERE "id" = $2 RETURNING "sequence"`,
          [now, runRecord.workspaceId]
        );
        const sequence = wsUpRes.rows[0]?.sequence ?? 1;
        await client.query(
          `INSERT INTO "interaction_events" ("id", "workspaceId", "sequence", "protocolVersion", "type", "revision", "payload", "createdAt")
           VALUES ($1, $2, $3, 1, 'run.changed', NULL, $4, $5)`,
          [
            crypto.randomUUID(),
            runRecord.workspaceId,
            sequence,
            JSON.stringify({ run: runRecord, assistantMessageId: params.assistantMessageId ?? null }),
            now
          ]
        );
        return true;
      });
    },
    async failRun(params) {
      const now = params.now ?? /* @__PURE__ */ new Date();
      return withTransaction(async (client) => {
        const runRes = await client.query(
          `SELECT * FROM "interaction_runs" WHERE "id" = $1 AND "leaseToken" = $2 AND "status" = 'running' FOR UPDATE`,
          [params.runId, params.leaseToken]
        );
        if (runRes.rows.length === 0) return false;
        const updatedRes = await client.query(
          `UPDATE "interaction_runs"
           SET "status" = 'failed', "error" = $1, "leaseOwner" = NULL, "leaseToken" = NULL, "leaseUntil" = NULL, "budgetActual" = $2, "updatedAt" = $3
           WHERE "id" = $4 RETURNING *`,
          [params.error, params.budgetActual ? JSON.stringify(params.budgetActual) : null, now, params.runId]
        );
        const runRecord = mapRun(updatedRes.rows[0]);
        const wsUpRes = await client.query(
          `UPDATE "interaction_workspaces" SET "sequence" = "sequence" + 1, "updatedAt" = $1 WHERE "id" = $2 RETURNING "sequence"`,
          [now, runRecord.workspaceId]
        );
        const sequence = wsUpRes.rows[0]?.sequence ?? 1;
        await client.query(
          `INSERT INTO "interaction_events" ("id", "workspaceId", "sequence", "protocolVersion", "type", "revision", "payload", "createdAt")
           VALUES ($1, $2, $3, 1, 'run.changed', NULL, $4, $5)`,
          [crypto.randomUUID(), runRecord.workspaceId, sequence, JSON.stringify({ run: runRecord, error: params.error }), now]
        );
        return true;
      });
    },
    async getRun(params) {
      let query = `SELECT * FROM "interaction_runs" WHERE "id" = $1`;
      const queryParams = [params.runId];
      if (params.workspaceId) {
        query += ` AND "workspaceId" = $2`;
        queryParams.push(params.workspaceId);
      }
      const res = await effectivePool.query(query, queryParams);
      if (res.rows.length === 0) return null;
      return mapRun(res.rows[0]);
    },
    async getActiveRun(params) {
      const wsRes = await effectivePool.query(
        `SELECT "id" FROM "interaction_workspaces" WHERE "id" = $1 AND "ownerId" = $2`,
        [params.workspaceId, params.ownerId]
      );
      if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
      const res = await effectivePool.query(
        `SELECT * FROM "interaction_runs" WHERE "workspaceId" = $1 AND "status" IN ('queued', 'running') LIMIT 1`,
        [params.workspaceId]
      );
      if (res.rows.length === 0) return null;
      return mapRun(res.rows[0]);
    },
    async recordStep(params) {
      return withTransaction(async (client) => {
        const runRes = await client.query(
          `SELECT "id", "leaseToken" FROM "interaction_runs" WHERE "id" = $1`,
          [params.runId]
        );
        if (runRes.rows.length === 0 || runRes.rows[0].leaseToken !== params.leaseToken) {
          throw new Error("FENCE_EXPIRED");
        }
        const existingRes = await client.query(
          `SELECT * FROM "interaction_steps" WHERE "runId" = $1 AND "ordinal" = $2`,
          [params.runId, params.ordinal]
        );
        const now = /* @__PURE__ */ new Date();
        if (existingRes.rows.length > 0) {
          const existing = existingRes.rows[0];
          if (existing.state === "completed" && params.state !== "completed") {
            return mapStep(existing);
          }
          const updatedRes = await client.query(
            `UPDATE "interaction_steps"
             SET "state" = $1, "result" = COALESCE($2, "result"), "error" = COALESCE($3, "error"), "updatedAt" = $4
             WHERE "id" = $5 RETURNING *`,
            [
              params.state,
              params.result !== void 0 ? JSON.stringify(params.result) : null,
              params.error ?? null,
              now,
              existing.id
            ]
          );
          return mapStep(updatedRes.rows[0]);
        }
        const stepId = crypto.randomUUID();
        const inputHash = params.inputPayload ? computePayloadHash(params.inputPayload) : null;
        const res = await client.query(
          `INSERT INTO "interaction_steps" ("id", "runId", "ordinal", "kind", "toolName", "inputHash", "inputPayload", "state", "result", "error", "effectKey", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING *`,
          [
            stepId,
            params.runId,
            params.ordinal,
            params.kind,
            params.toolName ?? null,
            inputHash,
            params.inputPayload ? JSON.stringify(params.inputPayload) : null,
            params.state,
            params.result ? JSON.stringify(params.result) : null,
            params.error ?? null,
            params.effectKey ?? null,
            now
          ]
        );
        return mapStep(res.rows[0]);
      });
    },
    async listSteps(params) {
      const res = await effectivePool.query(
        `SELECT * FROM "interaction_steps" WHERE "runId" = $1 ORDER BY "ordinal" ASC`,
        [params.runId]
      );
      return res.rows.map(mapStep);
    },
    async createProposal(params) {
      const wsRes = await effectivePool.query(
        `SELECT "id" FROM "interaction_workspaces" WHERE "id" = $1 AND "ownerId" = $2`,
        [params.workspaceId, params.ownerId]
      );
      if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
      const proposalId = params.id ?? crypto.randomUUID();
      const now = /* @__PURE__ */ new Date();
      const res = await effectivePool.query(
        `INSERT INTO "interaction_proposals" ("id", "workspaceId", "actionPayload", "readSet", "summary", "state", "expiresAt", "decisionActor", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, NULL, $7, $7) RETURNING *`,
        [
          proposalId,
          params.workspaceId,
          JSON.stringify(params.actionPayload),
          params.readSet ? JSON.stringify(params.readSet) : null,
          params.summary,
          params.expiresAt ?? null,
          now
        ]
      );
      return mapProposal(res.rows[0]);
    },
    async resolveProposal(params) {
      return withTransaction(async (client) => {
        const wsRes = await client.query(
          `SELECT "id" FROM "interaction_workspaces" WHERE "id" = $1 AND "ownerId" = $2`,
          [params.workspaceId, params.ownerId]
        );
        if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
        const pRes = await client.query(
          `SELECT * FROM "interaction_proposals" WHERE "id" = $1 AND "workspaceId" = $2 FOR UPDATE`,
          [params.proposalId, params.workspaceId]
        );
        if (pRes.rows.length === 0) throw new Error("PROPOSAL_NOT_FOUND");
        const proposal = pRes.rows[0];
        if (proposal.state !== "pending") throw new Error("STALE_PROPOSAL");
        if (proposal.expiresAt && new Date(proposal.expiresAt) < /* @__PURE__ */ new Date()) {
          await client.query(`UPDATE "interaction_proposals" SET "state" = 'expired' WHERE "id" = $1`, [params.proposalId]);
          throw new Error("PROPOSAL_EXPIRED");
        }
        const now = /* @__PURE__ */ new Date();
        const updatedRes = await client.query(
          `UPDATE "interaction_proposals" SET "state" = $1, "decisionActor" = $2, "updatedAt" = $3 WHERE "id" = $4 RETURNING *`,
          [params.decision, params.decisionActor, now, params.proposalId]
        );
        return mapProposal(updatedRes.rows[0]);
      });
    },
    async getProposal(params) {
      const wsRes = await effectivePool.query(
        `SELECT "id" FROM "interaction_workspaces" WHERE "id" = $1 AND "ownerId" = $2`,
        [params.workspaceId, params.ownerId]
      );
      if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
      const res = await effectivePool.query(
        `SELECT * FROM "interaction_proposals" WHERE "id" = $1 AND "workspaceId" = $2`,
        [params.proposalId, params.workspaceId]
      );
      if (res.rows.length === 0) return null;
      return mapProposal(res.rows[0]);
    },
    async listProposals(params) {
      const wsRes = await effectivePool.query(
        `SELECT "id" FROM "interaction_workspaces" WHERE "id" = $1 AND "ownerId" = $2`,
        [params.workspaceId, params.ownerId]
      );
      if (wsRes.rows.length === 0) throw new Error("WORKSPACE_NOT_FOUND");
      let query = `SELECT * FROM "interaction_proposals" WHERE "workspaceId" = $1`;
      const queryParams = [params.workspaceId];
      if (params.state) {
        query += ` AND "state" = $2`;
        queryParams.push(params.state);
      }
      query += ` ORDER BY "createdAt" DESC`;
      const res = await effectivePool.query(query, queryParams);
      return res.rows.map(mapProposal);
    }
  };
}
export {
  createPgInteractionRepository
};
//# sourceMappingURL=index.js.map
