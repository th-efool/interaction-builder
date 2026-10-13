// src/testkit/agenda-domain.ts
import { z as z2 } from "zod";

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

// src/testkit/agenda-domain.ts
var agendaItemSchema = z2.strictObject({
  id: z2.string().min(1),
  version: z2.number().int().nonnegative(),
  title: z2.string().min(1).max(200),
  durationMinutes: z2.number().int().min(1).max(240),
  presenter: z2.string().min(1).max(100),
  pinned: z2.boolean()
});
var agendaWorkspaceSchema = z2.strictObject({
  schemaVersion: z2.literal(1),
  meetingTitle: z2.string().min(1).max(200),
  date: z2.string(),
  items: z2.array(agendaItemSchema).max(50)
});
var agendaActionSchema = z2.discriminatedUnion("type", [
  z2.strictObject({
    type: z2.literal("set_meeting_title"),
    title: z2.string().min(1).max(200)
  }),
  z2.strictObject({
    type: z2.literal("edit_item"),
    itemId: z2.string().min(1),
    title: z2.string().min(1).max(200).optional(),
    durationMinutes: z2.number().int().min(1).max(240).optional()
  }),
  z2.strictObject({
    type: z2.literal("set_item_pin"),
    itemId: z2.string().min(1),
    pinned: z2.boolean()
  }),
  z2.strictObject({
    type: z2.literal("reorder_items"),
    itemIds: z2.array(z2.string()).min(1).max(50)
  })
]);
function planAgendaAction(state, actionInput, context) {
  const action = agendaActionSchema.parse(actionInput);
  if (context.expectedRevision !== context.currentRevision) {
    throw new Error("STALE_WORKSPACE");
  }
  const next = structuredClone(state);
  const changed = [];
  const invalidated = [];
  const touch = (item2) => {
    item2.version += 1;
    changed.push(entityRefSchema.parse({ kind: "agenda_item", id: item2.id, version: item2.version }));
  };
  if (action.type === "set_meeting_title") {
    next.meetingTitle = action.title;
    invalidated.push("overview");
    return {
      nextState: next,
      changed: [],
      invalidated,
      summary: `Meeting title updated to "${action.title}".`,
      undoable: true
    };
  }
  const item = action.type === "reorder_items" ? null : next.items.find((i) => i.id === action.itemId);
  if (action.type !== "reorder_items" && !item) {
    throw new Error("UNKNOWN_AGENDA_ITEM");
  }
  if (item) {
    const expected = context.entityVersions.get(item.id);
    if (expected !== void 0 && expected !== item.version) {
      throw new Error("STALE_ENTITY");
    }
  }
  if (action.type === "edit_item" && item) {
    if (action.title !== void 0 && item.pinned) {
      throw new Error("PINNED_ITEM_PROTECTED");
    }
    if (action.title !== void 0) item.title = action.title;
    if (action.durationMinutes !== void 0) item.durationMinutes = action.durationMinutes;
    touch(item);
    return {
      nextState: next,
      changed,
      invalidated: ["timing"],
      summary: `Agenda item "${item.id}" updated.`,
      undoable: true
    };
  }
  if (action.type === "set_item_pin" && item) {
    item.pinned = action.pinned;
    touch(item);
    return {
      nextState: next,
      changed,
      invalidated: [],
      summary: action.pinned ? `Item "${item.id}" pinned.` : `Item "${item.id}" unpinned.`,
      undoable: true
    };
  }
  if (action.type === "reorder_items") {
    const currentIds = new Set(next.items.map((i) => i.id));
    if (action.itemIds.length !== next.items.length || action.itemIds.some((id) => !currentIds.has(id)) || new Set(action.itemIds).size !== action.itemIds.length) {
      throw new Error("INVALID_AGENDA_ORDER");
    }
    const byId = new Map(next.items.map((i) => [i.id, i]));
    next.items = action.itemIds.map((id) => byId.get(id));
    next.items.forEach(touch);
    invalidated.push("timing");
    return {
      nextState: next,
      changed,
      invalidated,
      summary: "Agenda items reordered.",
      undoable: true
    };
  }
  throw new Error("UNSUPPORTED_ACTION");
}
var sampleAgenda = {
  schemaVersion: 1,
  meetingTitle: "Engineering Sync",
  date: "2026-10-14",
  items: [
    {
      id: "item-1",
      version: 0,
      title: "Architecture Review",
      durationMinutes: 15,
      presenter: "Alice",
      pinned: false
    },
    {
      id: "item-2",
      version: 0,
      title: "Roadmap Planning",
      durationMinutes: 20,
      presenter: "Bob",
      pinned: true
    }
  ]
};
var agendaDomain = {
  id: "agenda",
  version: 1,
  initialState: (b) => agendaWorkspaceSchema.parse(b),
  plan: planAgendaAction
};

// src/testkit/mock-model.ts
import { MockLanguageModelV4 } from "ai/test";
function createScriptedModelAdapter(turns) {
  let turnIdx = 0;
  return {
    async executeTurn(input) {
      let stepsCount = 0;
      while (turnIdx < turns.length) {
        const turn = turns[turnIdx];
        turnIdx += 1;
        stepsCount += 1;
        if (turn.toolCalls && turn.toolCalls.length > 0) {
          for (const tc of turn.toolCalls) {
            const tool = input.tools[tc.toolName];
            if (!tool) {
              throw new Error(`Tool not found: ${tc.toolName}`);
            }
            if (typeof tool.execute === "function") {
              await tool.execute(tc.input);
            }
          }
          if (turn.text) {
            return { text: turn.text, stepsCount };
          }
        } else {
          return { text: turn.text ?? "Completed turn.", stepsCount };
        }
      }
      return { text: "Done.", stepsCount: Math.max(1, stepsCount) };
    }
  };
}
function createScriptedLanguageModel(turns) {
  let turnIdx = 0;
  const defaultUsage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 }
  };
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const turn = turns[turnIdx] ?? { text: "Done." };
      turnIdx += 1;
      if (turn.toolCalls && turn.toolCalls.length > 0) {
        return {
          content: turn.toolCalls.map((tc, idx) => ({
            type: "tool-call",
            toolCallId: tc.toolCallId ?? `call-${turnIdx}-${idx}`,
            toolName: tc.toolName,
            input: JSON.stringify(tc.input)
          })),
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: defaultUsage,
          warnings: []
        };
      }
      return {
        content: [
          {
            type: "text",
            text: turn.text ?? "Completed turn."
          }
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: defaultUsage,
        warnings: []
      };
    }
  });
}

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

// src/runtime/memory.repository.ts
var MemoryInteractionRepository = class {
  workspaces = /* @__PURE__ */ new Map();
  events = /* @__PURE__ */ new Map();
  outbox = /* @__PURE__ */ new Map();
  requests = /* @__PURE__ */ new Map();
  messages = /* @__PURE__ */ new Map();
  runs = /* @__PURE__ */ new Map();
  steps = /* @__PURE__ */ new Map();
  proposals = /* @__PURE__ */ new Map();
  async appendMessage(input) {
    const ws = this.workspaces.get(input.workspaceId);
    if (!ws || ws.ownerId !== input.ownerId) throw new Error("WORKSPACE_NOT_FOUND");
    const payload = { id: input.id, role: input.role, parts: input.parts, runId: input.runId ?? null };
    let key = null;
    if (input.requestId) {
      key = `${input.workspaceId}:${input.ownerId}:appendMessage:${input.requestId}`;
      const prior = this.requests.get(key);
      if (prior) {
        if (prior.payloadHash !== computePayloadHash(payload)) throw new Error("IDEMPOTENCY_MISMATCH");
        return structuredClone(prior.response);
      }
    }
    const sequence = ws.sequence + 1;
    ws.sequence = sequence;
    ws.updatedAt = /* @__PURE__ */ new Date();
    const message = {
      id: input.id,
      workspaceId: input.workspaceId,
      role: input.role,
      parts: structuredClone(input.parts),
      sequence,
      runId: input.runId ?? null,
      createdAt: /* @__PURE__ */ new Date()
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
      type: "message.accepted",
      revision: null,
      payload: { message: structuredClone(message) },
      createdAt: /* @__PURE__ */ new Date()
    });
    let scheduledRun;
    if (input.scheduleRun !== false && input.role === "user") {
      const active = Array.from(this.runs.values()).find(
        (r) => r.workspaceId === input.workspaceId && (r.status === "queued" || r.status === "running")
      );
      if (active) {
        scheduledRun = structuredClone(active);
      } else {
        const runId = crypto.randomUUID();
        const runRecord = {
          id: runId,
          workspaceId: input.workspaceId,
          triggeringMessageId: input.id,
          status: "queued",
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
          createdAt: /* @__PURE__ */ new Date(),
          updatedAt: /* @__PURE__ */ new Date()
        };
        this.runs.set(runId, runRecord);
        this.outbox.set(`run:${runId}`, {
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          kind: "assistant_run",
          payload: { runId, workspaceId: input.workspaceId },
          dedupKey: `run:${runId}`,
          status: "pending",
          attempts: 0,
          dueAt: /* @__PURE__ */ new Date(),
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
          deliveredAt: null,
          createdAt: /* @__PURE__ */ new Date(),
          updatedAt: /* @__PURE__ */ new Date()
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
        operation: "appendMessage",
        requestId: input.requestId,
        payloadHash: computePayloadHash(payload),
        response: structuredClone(result),
        createdAt: /* @__PURE__ */ new Date()
      });
    }
    return result;
  }
  async listMessages(p) {
    const ws = this.workspaces.get(p.workspaceId);
    if (!ws || ws.ownerId !== p.ownerId) throw new Error("WORKSPACE_NOT_FOUND");
    const all = (this.messages.get(p.workspaceId) ?? []).filter((m) => p.beforeSequence === void 0 || m.sequence < p.beforeSequence);
    return all.slice(-(p.limit ?? 50)).map((m) => structuredClone(m));
  }
  async createWorkspace(params) {
    const existing = this.workspaces.get(params.id);
    if (existing) {
      if (existing.ownerId !== params.ownerId) {
        throw new Error("WORKSPACE_OWNER_MISMATCH");
      }
      return structuredClone(existing);
    }
    const now = /* @__PURE__ */ new Date();
    const record = {
      id: params.id,
      ownerId: params.ownerId,
      domainId: params.domainId,
      domainVersion: params.domainVersion,
      snapshot: structuredClone(params.initialSnapshot),
      revision: 0,
      contextEpoch: 0,
      sequence: 0,
      lifecycle: "active",
      createdAt: now,
      updatedAt: now
    };
    this.workspaces.set(params.id, record);
    this.events.set(params.id, []);
    return structuredClone(record);
  }
  async loadWorkspace(params) {
    const workspace = this.workspaces.get(params.workspaceId);
    if (!workspace || workspace.ownerId !== params.ownerId) {
      return null;
    }
    return structuredClone(workspace);
  }
  async commitAction(input) {
    let payloadHash = null;
    let requestKey = null;
    if (input.requestId) {
      payloadHash = computePayloadHash(input.envelope);
      requestKey = `${input.workspaceId}:${input.ownerId}:commitAction:${input.requestId}`;
      const existingRequest = this.requests.get(requestKey);
      if (existingRequest) {
        if (existingRequest.payloadHash !== payloadHash) {
          throw new Error("IDEMPOTENCY_MISMATCH");
        }
        return structuredClone(existingRequest.response);
      }
    }
    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace || workspace.ownerId !== input.ownerId) {
      throw new Error("WORKSPACE_NOT_FOUND");
    }
    if (workspace.lifecycle !== "active") {
      throw new Error("WORKSPACE_NOT_ACTIVE");
    }
    if (input.runFence) {
      const run = this.runs.get(input.runFence.runId);
      if (!run || run.status === "canceled") throw new Error("RUN_CANCELED");
      if (run.leaseToken !== input.runFence.leaseToken) throw new Error("FENCE_EXPIRED");
      if (run.leaseUntil && run.leaseUntil < /* @__PURE__ */ new Date()) throw new Error("FENCE_EXPIRED");
    }
    if (workspace.revision !== input.expectedRevision) {
      throw new Error("STALE_WORKSPACE");
    }
    const commitResult = planActionCommit({
      state: workspace.snapshot,
      currentRevision: workspace.revision,
      envelope: input.envelope,
      plan: input.plan
    });
    const nextSequence = workspace.sequence + 1;
    const now = /* @__PURE__ */ new Date();
    workspace.snapshot = structuredClone(commitResult.state);
    workspace.revision = commitResult.revision;
    workspace.contextEpoch += 1;
    workspace.sequence = nextSequence;
    workspace.updatedAt = now;
    const eventRecord = {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      sequence: nextSequence,
      protocolVersion: 1,
      type: "workspace.committed",
      revision: commitResult.revision,
      payload: {
        receipt: commitResult.receipt,
        snapshot: structuredClone(commitResult.state)
      },
      createdAt: now
    };
    const eventList = this.events.get(input.workspaceId) ?? [];
    eventList.push(eventRecord);
    this.events.set(input.workspaceId, eventList);
    if (input.outboxItems) {
      for (const item of input.outboxItems) {
        if (this.outbox.has(item.dedupKey)) continue;
        const outboxRecord = {
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          kind: item.kind,
          payload: structuredClone(item.payload),
          dedupKey: item.dedupKey,
          status: "pending",
          attempts: 0,
          dueAt: now,
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
          deliveredAt: null,
          createdAt: now,
          updatedAt: now
        };
        this.outbox.set(item.dedupKey, outboxRecord);
      }
    }
    const successResponse = {
      state: structuredClone(commitResult.state),
      revision: commitResult.revision,
      sequence: nextSequence,
      receipt: commitResult.receipt
    };
    if (requestKey && payloadHash) {
      this.requests.set(requestKey, {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        actorId: input.ownerId,
        operation: "commitAction",
        requestId: input.requestId,
        payloadHash,
        response: structuredClone(successResponse),
        createdAt: /* @__PURE__ */ new Date()
      });
    }
    return successResponse;
  }
  async queryEvents(params) {
    const workspace = this.workspaces.get(params.workspaceId);
    if (!workspace || workspace.ownerId !== params.ownerId) {
      throw new Error("WORKSPACE_NOT_FOUND");
    }
    const after = params.afterSequence ?? 0;
    const limit = params.limit ?? 100;
    const all = this.events.get(params.workspaceId) ?? [];
    return all.filter((event) => event.sequence > after).slice(0, limit).map((event) => structuredClone(event));
  }
  async claimOutbox(options) {
    const now = options.now ?? /* @__PURE__ */ new Date();
    const limit = options.limit ?? 50;
    const claimed = [];
    for (const record of this.outbox.values()) {
      if (claimed.length >= limit) break;
      const isDue = record.dueAt <= now;
      const isPending = record.status === "pending";
      const isExpiredLease = record.status === "delivering" && record.leaseUntil !== null && record.leaseUntil < now;
      if (isDue && (isPending || isExpiredLease)) {
        record.status = "delivering";
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
  async ackOutbox(params) {
    const now = params.now ?? /* @__PURE__ */ new Date();
    const idSet = new Set(params.ids);
    let ackedCount = 0;
    for (const record of this.outbox.values()) {
      if (idSet.has(record.id) && record.status === "delivering" && record.leaseToken === params.leaseToken) {
        record.status = "delivered";
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
  async failOutbox(params) {
    const now = params.now ?? /* @__PURE__ */ new Date();
    for (const record of this.outbox.values()) {
      if (record.id === params.id && record.status === "delivering" && record.leaseToken === params.leaseToken) {
        const backoff = params.retryInMs ?? 5e3 * Math.pow(2, record.attempts);
        record.status = "pending";
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
  async scheduleRun(params) {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error("WORKSPACE_NOT_FOUND");
    const active = Array.from(this.runs.values()).find(
      (r) => r.workspaceId === params.workspaceId && (r.status === "queued" || r.status === "running")
    );
    if (active) return structuredClone(active);
    const runId = params.runId ?? crypto.randomUUID();
    const runRecord = {
      id: runId,
      workspaceId: params.workspaceId,
      triggeringMessageId: params.triggeringMessageId ?? null,
      status: "queued",
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
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    };
    this.runs.set(runId, runRecord);
    this.outbox.set(`run:${runId}`, {
      id: crypto.randomUUID(),
      workspaceId: params.workspaceId,
      kind: "assistant_run",
      payload: { runId, workspaceId: params.workspaceId },
      dedupKey: `run:${runId}`,
      status: "pending",
      attempts: 0,
      dueAt: /* @__PURE__ */ new Date(),
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      deliveredAt: null,
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    });
    const events = this.events.get(params.workspaceId) ?? [];
    events.push({
      id: crypto.randomUUID(),
      workspaceId: params.workspaceId,
      sequence: ws.sequence + 1,
      protocolVersion: 1,
      type: "run.changed",
      revision: null,
      payload: { run: structuredClone(runRecord) },
      createdAt: /* @__PURE__ */ new Date()
    });
    ws.sequence += 1;
    this.events.set(params.workspaceId, events);
    return structuredClone(runRecord);
  }
  async claimRun(params) {
    const now = params.now ?? /* @__PURE__ */ new Date();
    for (const run of this.runs.values()) {
      if (params.workspaceId && run.workspaceId !== params.workspaceId) continue;
      const isQueued = run.status === "queued";
      const isExpiredRunning = run.status === "running" && run.leaseUntil !== null && run.leaseUntil < now;
      if (isQueued || isExpiredRunning) {
        run.status = "running";
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
          type: "run.changed",
          revision: null,
          payload: { run: structuredClone(run) },
          createdAt: now
        });
        return structuredClone(run);
      }
    }
    return null;
  }
  async heartbeatRun(params) {
    const now = params.now ?? /* @__PURE__ */ new Date();
    const run = this.runs.get(params.runId);
    if (!run || run.leaseToken !== params.leaseToken || run.status !== "running") return false;
    run.leaseUntil = new Date(now.getTime() + params.leaseDurationMs);
    run.updatedAt = now;
    return true;
  }
  async cancelRun(params) {
    const now = params.now ?? /* @__PURE__ */ new Date();
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error("WORKSPACE_NOT_FOUND");
    const run = this.runs.get(params.runId);
    if (!run || run.workspaceId !== params.workspaceId) return false;
    if (run.status === "completed" || run.status === "failed" || run.status === "canceled") return false;
    run.status = "canceled";
    run.fence += 1;
    run.error = params.reason ?? "Canceled by user";
    run.updatedAt = now;
    const events = this.events.get(params.workspaceId) ?? [];
    events.push({
      id: crypto.randomUUID(),
      workspaceId: params.workspaceId,
      sequence: ws.sequence + 1,
      protocolVersion: 1,
      type: "run.changed",
      revision: null,
      payload: { run: structuredClone(run) },
      createdAt: now
    });
    ws.sequence += 1;
    return true;
  }
  async completeRun(params) {
    const now = params.now ?? /* @__PURE__ */ new Date();
    const run = this.runs.get(params.runId);
    if (!run || run.leaseToken !== params.leaseToken || run.status !== "running") return false;
    run.status = "completed";
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
        type: "run.changed",
        revision: null,
        payload: { run: structuredClone(run), assistantMessageId: params.assistantMessageId ?? null },
        createdAt: now
      });
      ws.sequence += 1;
    }
    return true;
  }
  async failRun(params) {
    const now = params.now ?? /* @__PURE__ */ new Date();
    const run = this.runs.get(params.runId);
    if (!run || run.leaseToken !== params.leaseToken || run.status !== "running") return false;
    run.status = "failed";
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
        type: "run.changed",
        revision: null,
        payload: { run: structuredClone(run), error: params.error },
        createdAt: now
      });
      ws.sequence += 1;
    }
    return true;
  }
  async getRun(params) {
    const run = this.runs.get(params.runId);
    if (!run) return null;
    if (params.workspaceId && run.workspaceId !== params.workspaceId) return null;
    return structuredClone(run);
  }
  async getActiveRun(params) {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error("WORKSPACE_NOT_FOUND");
    const run = Array.from(this.runs.values()).find(
      (r) => r.workspaceId === params.workspaceId && (r.status === "queued" || r.status === "running")
    );
    return run ? structuredClone(run) : null;
  }
  /** Execution Journal (Steps) */
  async recordStep(params) {
    const run = this.runs.get(params.runId);
    if (!run || run.leaseToken !== params.leaseToken) throw new Error("FENCE_EXPIRED");
    const steps = this.steps.get(params.runId) ?? [];
    const existingIdx = steps.findIndex((s) => s.ordinal === params.ordinal);
    if (existingIdx !== -1) {
      const existing = steps[existingIdx];
      if (existing.state === "completed" && params.state !== "completed") {
        return structuredClone(existing);
      }
      existing.state = params.state;
      if (params.result !== void 0) existing.result = structuredClone(params.result);
      if (params.error !== void 0) existing.error = params.error;
      existing.updatedAt = /* @__PURE__ */ new Date();
      return structuredClone(existing);
    }
    const stepRecord = {
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
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    };
    steps.push(stepRecord);
    this.steps.set(params.runId, steps);
    return structuredClone(stepRecord);
  }
  async listSteps(params) {
    const steps = this.steps.get(params.runId) ?? [];
    return steps.sort((a, b) => a.ordinal - b.ordinal).map((s) => structuredClone(s));
  }
  /** Proposals Lifecycle */
  async createProposal(params) {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error("WORKSPACE_NOT_FOUND");
    const proposalId = params.id ?? crypto.randomUUID();
    const proposal = {
      id: proposalId,
      workspaceId: params.workspaceId,
      actionPayload: structuredClone(params.actionPayload),
      readSet: params.readSet ? structuredClone(params.readSet) : null,
      summary: params.summary,
      state: "pending",
      expiresAt: params.expiresAt ?? null,
      decisionActor: null,
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    };
    this.proposals.set(proposalId, proposal);
    return structuredClone(proposal);
  }
  async resolveProposal(params) {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error("WORKSPACE_NOT_FOUND");
    const proposal = this.proposals.get(params.proposalId);
    if (!proposal || proposal.workspaceId !== params.workspaceId) throw new Error("PROPOSAL_NOT_FOUND");
    if (proposal.state !== "pending") throw new Error("STALE_PROPOSAL");
    if (proposal.expiresAt && proposal.expiresAt < /* @__PURE__ */ new Date()) {
      proposal.state = "expired";
      throw new Error("PROPOSAL_EXPIRED");
    }
    proposal.state = params.decision;
    proposal.decisionActor = params.decisionActor;
    proposal.updatedAt = /* @__PURE__ */ new Date();
    return structuredClone(proposal);
  }
  async getProposal(params) {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error("WORKSPACE_NOT_FOUND");
    const p = this.proposals.get(params.proposalId);
    return p && p.workspaceId === params.workspaceId ? structuredClone(p) : null;
  }
  async listProposals(params) {
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.ownerId !== params.ownerId) throw new Error("WORKSPACE_NOT_FOUND");
    return Array.from(this.proposals.values()).filter((p) => p.workspaceId === params.workspaceId && (!params.state || p.state === params.state)).map((p) => structuredClone(p));
  }
};
function createMemoryInteractionRepository() {
  return new MemoryInteractionRepository();
}
export {
  MemoryInteractionRepository,
  MockLanguageModelV4,
  agendaActionSchema,
  agendaDomain,
  agendaItemSchema,
  agendaWorkspaceSchema,
  createMemoryInteractionRepository,
  createScriptedLanguageModel,
  createScriptedModelAdapter,
  planAgendaAction,
  sampleAgenda
};
//# sourceMappingURL=index.js.map
