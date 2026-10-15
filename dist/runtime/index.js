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
function deterministicUuid(seed) {
  const hash = createHash("sha256").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
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
function planBatchActionCommit(input) {
  if (!Array.isArray(input.envelopes) || input.envelopes.length === 0) {
    return { state: input.state, revision: input.currentRevision, receipts: [] };
  }
  let currentState = input.state;
  let rev = input.currentRevision;
  const receipts = [];
  for (const rawEnvelope of input.envelopes) {
    const res = planActionCommit({
      state: currentState,
      currentRevision: rev,
      envelope: rawEnvelope,
      plan: input.plan,
      telemetry: input.telemetry
    });
    currentState = res.state;
    rev = res.revision;
    receipts.push(res.receipt);
  }
  return { state: currentState, revision: rev, receipts };
}

// src/runtime/handlers.ts
import { z as z2 } from "zod";
var createSchema = z2.strictObject({
  workspaceId: z2.string().uuid(),
  domainId: z2.string().min(1).max(80),
  bootstrap: z2.unknown()
});
var sendMessageSchema = z2.strictObject({
  id: z2.string().uuid(),
  parts: z2.array(
    z2.discriminatedUnion("type", [
      z2.strictObject({ type: z2.literal("text"), text: z2.string().trim().min(1).max(8e3) }),
      z2.strictObject({
        type: z2.literal("entity_ref"),
        entity: z2.strictObject({
          kind: z2.string().min(1).max(80),
          id: z2.string().min(1).max(200),
          version: z2.number().int().nonnegative()
        }),
        label: z2.string().max(300)
      })
    ])
  ).min(1).max(20)
});
var cancelRunSchema = z2.strictObject({
  reason: z2.string().max(500).optional()
});
var decideProposalSchema = z2.strictObject({
  decision: z2.enum(["accepted", "rejected"])
});
var ERROR_STATUS = {
  STALE_WORKSPACE: 409,
  STALE_ENTITY: 409,
  IDEMPOTENCY_MISMATCH: 409,
  WORKSPACE_NOT_FOUND: 404,
  WORKSPACE_OWNER_MISMATCH: 404,
  WORKSPACE_NOT_ACTIVE: 409,
  RUN_NOT_FOUND: 404,
  RUN_CANCELED: 409,
  FENCE_EXPIRED: 409,
  PROPOSAL_NOT_FOUND: 404,
  STALE_PROPOSAL: 409,
  PROPOSAL_EXPIRED: 410
};
function toErrorResult(err, correlationId = crypto.randomUUID()) {
  const code = err instanceof Error ? err.message : "INTERNAL";
  if (err instanceof z2.ZodError || err instanceof Error && err.name === "ZodError" && Array.isArray(err.issues)) {
    return {
      status: 400,
      body: { code: "INVALID_ACTION", message: "Invalid request", retryable: false, correlationId }
    };
  }
  const status = ERROR_STATUS[code];
  if (status) {
    return {
      status,
      body: {
        code: status === 404 ? "NOT_FOUND" : code === "STALE_WORKSPACE" || code === "STALE_ENTITY" ? "CONFLICT" : code,
        message: code,
        retryable: false,
        correlationId
      }
    };
  }
  if (/^[A-Z_]+$/.test(code)) {
    return {
      status: 422,
      body: { code: "INVALID_ACTION", message: code, retryable: false, correlationId }
    };
  }
  return {
    status: 500,
    body: { code: "INTERNAL", message: "Internal error", retryable: true, correlationId }
  };
}
function createInteractionHandlers(deps) {
  return {
    async createWorkspace(ownerId, input) {
      try {
        const body = createSchema.parse(input);
        const domain = deps.domains.get(body.domainId);
        if (!domain) {
          return {
            status: 400,
            body: { code: "INVALID_ACTION", message: "Unknown domain", retryable: false }
          };
        }
        const ws = await deps.repo.createWorkspace({
          id: body.workspaceId,
          ownerId,
          domainId: domain.id,
          domainVersion: domain.version,
          initialSnapshot: domain.initialState(body.bootstrap)
        });
        return {
          status: 201,
          body: {
            workspaceId: ws.id,
            revision: ws.revision,
            cursor: ws.sequence,
            snapshot: ws.snapshot
          }
        };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    async getWorkspace(ownerId, workspaceId) {
      try {
        const ws = await deps.repo.loadWorkspace({ workspaceId, ownerId });
        if (!ws) return toErrorResult(new Error("WORKSPACE_NOT_FOUND"));
        const messages = await deps.repo.listMessages({ workspaceId, ownerId, limit: 50 });
        return {
          status: 200,
          body: {
            workspaceId: ws.id,
            domainId: ws.domainId,
            revision: ws.revision,
            cursor: ws.sequence,
            snapshot: ws.snapshot,
            lifecycle: ws.lifecycle,
            messages
          }
        };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    /** User chat turn: durable + idempotent. Atomically accepts message and schedules run intent. */
    async sendMessage(ownerId, workspaceId, requestId, input) {
      try {
        const body = sendMessageSchema.parse(input);
        const { message, sequence, run } = await deps.repo.appendMessage({
          workspaceId,
          ownerId,
          id: body.id,
          role: "user",
          parts: body.parts,
          requestId
        });
        return { status: 202, body: { message, cursor: sequence, runId: run?.id } };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    async runAssistant(ownerId, workspaceId) {
      try {
        const run = await deps.repo.scheduleRun({ workspaceId, ownerId });
        if (deps.runAssistant) {
          return await deps.runAssistant(ownerId, workspaceId);
        }
        return { status: 200, body: { run } };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    async cancelRun(ownerId, workspaceId, runId, input) {
      try {
        const reason = input ? cancelRunSchema.parse(input).reason : void 0;
        const ok = await deps.repo.cancelRun({ runId, workspaceId, ownerId, reason });
        if (!ok) {
          return {
            status: 404,
            body: { code: "RUN_NOT_FOUND", message: "Run not found or already terminal", retryable: false }
          };
        }
        return { status: 200, body: { canceled: true } };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    async getActiveRun(ownerId, workspaceId) {
      try {
        const run = await deps.repo.getActiveRun({ workspaceId, ownerId });
        return { status: 200, body: { run } };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    async getRun(ownerId, workspaceId, runId) {
      try {
        const run = await deps.repo.getRun({ runId, workspaceId });
        if (!run) {
          return { status: 404, body: { code: "RUN_NOT_FOUND", message: "Run not found", retryable: false } };
        }
        return { status: 200, body: { run } };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    async decideProposal(ownerId, workspaceId, proposalId, input) {
      try {
        const { decision } = decideProposalSchema.parse(input);
        const proposal = await deps.repo.resolveProposal({
          proposalId,
          workspaceId,
          ownerId,
          decision,
          decisionActor: ownerId
        });
        return { status: 200, body: { proposal } };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    async listProposals(ownerId, workspaceId, state) {
      try {
        const proposals = await deps.repo.listProposals({ workspaceId, ownerId, state });
        return { status: 200, body: { proposals } };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    async listMessages(ownerId, workspaceId, beforeSequence) {
      try {
        return {
          status: 200,
          body: {
            messages: await deps.repo.listMessages({ workspaceId, ownerId, beforeSequence, limit: 50 })
          }
        };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    /** Single action path shared by UI and model tool dispatch. */
    async commitAction(ownerId, requestId, input) {
      try {
        const envelope = actionEnvelopeSchema.parse(input);
        const ws = await deps.repo.loadWorkspace({ workspaceId: envelope.workspaceId, ownerId });
        if (!ws) return toErrorResult(new Error("WORKSPACE_NOT_FOUND"));
        const domain = deps.domains.get(ws.domainId);
        if (!domain) return toErrorResult(new Error("UNKNOWN_DOMAIN"));
        const res = await deps.repo.commitAction({
          workspaceId: ws.id,
          ownerId,
          expectedRevision: envelope.expectedRevision,
          envelope,
          plan: domain.plan,
          requestId
        });
        return {
          status: 200,
          body: {
            revision: res.revision,
            cursor: res.sequence,
            receipt: res.receipt,
            snapshot: res.state
          }
        };
      } catch (e) {
        return toErrorResult(e);
      }
    },
    async getEvents(ownerId, workspaceId, after = 0) {
      try {
        const events = await deps.repo.queryEvents({ workspaceId, ownerId, afterSequence: after });
        return { status: 200, body: { events } };
      } catch (e) {
        return toErrorResult(e);
      }
    }
  };
}

// src/runtime/runner.ts
async function runAssistantTurn(opts) {
  if (opts.signal?.aborted) throw new Error("RUN_ABORTED");
  const { workspaceId, ownerId, repo, domain, model, runId, leaseToken } = opts;
  const turnStartTime = Date.now();
  if (runId && opts.telemetry) {
    opts.telemetry.onTurnStart?.({
      workspaceId,
      runId,
      timestamp: turnStartTime
    });
  }
  const ws = await repo.loadWorkspace({ workspaceId, ownerId });
  if (!ws) throw new Error("WORKSPACE_NOT_FOUND");
  if (ws.lifecycle !== "active") throw new Error("WORKSPACE_NOT_ACTIVE");
  let observedRevision = opts.observedRevision ?? ws.revision;
  let triggeringMessageId = null;
  if (runId) {
    const run = await repo.getRun({ runId, workspaceId });
    if (run) {
      if (run.status === "canceled") throw new Error("RUN_CANCELED");
      observedRevision = run.observedRevision;
      triggeringMessageId = run.triggeringMessageId;
    }
  }
  let history;
  if (triggeringMessageId) {
    let page = await repo.listMessages({ workspaceId, ownerId, limit: 100 });
    let trigger = page.find((message) => message.id === triggeringMessageId);
    while (!trigger && page.length === 100) {
      page = await repo.listMessages({ workspaceId, ownerId, beforeSequence: page[0].sequence, limit: 100 });
      trigger = page.find((message) => message.id === triggeringMessageId);
    }
    if (!trigger) throw new Error("TRIGGERING_MESSAGE_NOT_FOUND");
    history = await repo.listMessages({ workspaceId, ownerId, beforeSequence: trigger.sequence + 1, limit: 20 });
  } else {
    history = await repo.listMessages({ workspaceId, ownerId, limit: 20 });
  }
  if (history.length === 0) {
    return { success: true, assistantMessageId: null, text: "", stepsCount: 0, runId };
  }
  const modelMessages = [];
  for (const m of history) {
    let content = "";
    for (const part of m.parts) {
      if (part.type === "text" && part.text) {
        content += (content ? "\n" : "") + part.text;
      } else if (part.type === "entity_ref" && part.entity) {
        content += (content ? "\n" : "") + `[Selected entity: ${part.label ?? part.entity.id} (${part.entity.kind} id=${part.entity.id})]`;
      }
    }
    if (content.trim()) {
      if (m.role === "user") {
        modelMessages.push({ role: "user", content });
      } else if (m.role === "assistant") {
        modelMessages.push({ role: "assistant", content });
      }
    }
  }
  if (modelMessages.length === 0 || modelMessages[modelMessages.length - 1]?.role !== "user") {
    return { success: true, assistantMessageId: null, text: "", stepsCount: 0, runId };
  }
  const defaultSystem = `You are an AI assistant collaborating with the user on this workspace.
Current workspace state:
${JSON.stringify(ws.snapshot, null, 2)}
Revision: ${observedRevision}

Instructions:
1. When the user asks for changes, call the provided tools to update the workspace.
2. Every tool call directly modifies the live workspace for the user.
3. Be concise and clear in your responses.`;
  const system = opts.systemPrompt ?? defaultSystem;
  const journaledSteps = runId ? await repo.listSteps({ runId }) : [];
  let toolInvocationIndex = 0;
  let lastToolError = null;
  const onToolStep = async (toolName, inputPayload, actionFn) => {
    if (opts.signal?.aborted) throw new Error("RUN_ABORTED");
    toolInvocationIndex += 1;
    const currentOrdinal = toolInvocationIndex;
    const inputHash = computePayloadHash(inputPayload);
    const requestId = runId ? `step:${runId}:${currentOrdinal}` : void 0;
    const existing = journaledSteps.find((s) => s.ordinal === currentOrdinal && s.kind === "tool_call");
    if (existing) {
      if (existing.toolName !== toolName) {
        throw new Error(
          `DIVERGENT_REPLAY: Expected tool ${existing.toolName} at ordinal ${currentOrdinal}, received ${toolName}`
        );
      }
      if (existing.inputHash && existing.inputHash !== inputHash) {
        throw new Error(
          `DIVERGENT_REPLAY: Input hash mismatch for tool ${toolName} at ordinal ${currentOrdinal}`
        );
      }
      if (existing.state === "completed") {
        return existing.result;
      }
    }
    if (runId && leaseToken && !existing) {
      await repo.recordStep({
        runId,
        leaseToken,
        ordinal: currentOrdinal,
        kind: "tool_call",
        toolName,
        inputHash,
        inputPayload,
        state: "started",
        effectKey: requestId
      });
    }
    try {
      const res = await actionFn({ ordinal: currentOrdinal, requestId: requestId ?? "" });
      if (runId && leaseToken) {
        await repo.recordStep({
          runId,
          leaseToken,
          ordinal: currentOrdinal,
          kind: "tool_call",
          toolName,
          inputHash,
          inputPayload,
          state: "completed",
          result: res,
          effectKey: requestId
        });
      }
      return res;
    } catch (err) {
      lastToolError = err;
      if (runId && leaseToken) {
        await repo.recordStep({
          runId,
          leaseToken,
          ordinal: currentOrdinal,
          kind: "tool_call",
          toolName,
          inputHash,
          inputPayload,
          state: "failed",
          error: err.message ?? String(err),
          effectKey: requestId
        });
      }
      throw err;
    }
  };
  const runFence = runId && leaseToken ? { runId, leaseToken } : void 0;
  const tools = opts.createTools({
    workspaceId,
    ownerId,
    repo,
    domain,
    observedRevision,
    runFence,
    onToolStep
  });
  if (runId && leaseToken) {
    await repo.recordStep({
      runId,
      leaseToken,
      ordinal: 0,
      kind: "model_call",
      state: "started"
    });
  }
  if (!model || typeof model.executeTurn !== "function") {
    throw new Error(
      "MODEL_ADAPTER_REQUIRED: model must implement InteractionModelAdapter. Wrap LanguageModel using createAiSdkModelAdapter."
    );
  }
  let result;
  try {
    result = await model.executeTurn({
      systemPrompt: system,
      messages: modelMessages,
      tools,
      maxSteps: opts.maxSteps
    });
    if (lastToolError) {
      throw lastToolError;
    }
    if (runId && leaseToken) {
      await repo.recordStep({
        runId,
        leaseToken,
        ordinal: 0,
        kind: "model_call",
        state: "completed",
        result: { text: result.text, stepsCount: result.stepsCount, usage: result.usage }
      });
    }
  } catch (err) {
    if (runId && opts.telemetry) {
      opts.telemetry.onTurnEnd?.({
        workspaceId,
        runId,
        durationMs: Date.now() - turnStartTime,
        success: false,
        error: err
      });
    }
    if (runId && leaseToken) {
      await repo.recordStep({
        runId,
        leaseToken,
        ordinal: 0,
        kind: "model_call",
        state: "failed",
        error: err.message ?? String(err)
      });
    }
    throw err;
  }
  const responseText = result.text.trim();
  let assistantMessageId = null;
  if (responseText) {
    assistantMessageId = crypto.randomUUID();
    await repo.appendMessage({
      workspaceId,
      ownerId,
      id: assistantMessageId,
      role: "assistant",
      parts: [{ type: "text", text: responseText }],
      runId: runId ?? null
    });
  }
  if (runId && opts.telemetry) {
    opts.telemetry.onTurnEnd?.({
      workspaceId,
      runId,
      durationMs: Date.now() - turnStartTime,
      success: true,
      stepsCount: result.stepsCount
    });
  }
  return {
    success: true,
    assistantMessageId,
    text: responseText,
    stepsCount: result.stepsCount,
    usage: result.usage,
    runId
  };
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
      budgetReservation: params.budgetReservation ?? null,
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

// src/runtime/sse.ts
var SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive"
};
var frame = (e) => `id: ${e.sequence}
event: ${e.type}
data: ${JSON.stringify(e)}

`;
async function streamEvents(h, ownerId, workspaceId, after, opts = {}) {
  const first = await h.getEvents(ownerId, workspaceId, after);
  if (first.status !== 200) return new Response(JSON.stringify(first.body), { status: first.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const { pollMs = 1e3, maxMs = 25e3, heartbeatMs = 1e4, signal } = opts;
  const enc = new TextEncoder();
  let cursor = after;
  let closed = false;
  let onAbort;
  const stream = new ReadableStream({
    async start(controller) {
      const started = Date.now();
      let lastBeat = started;
      const send = (s) => controller.enqueue(enc.encode(s));
      const close = () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
          }
        }
      };
      onAbort = close;
      if (signal) {
        if (signal.aborted) {
          close();
          return;
        }
        signal.addEventListener("abort", close);
      }
      send("retry: 1000\n\n");
      let batch = first.body.events;
      try {
        while (!closed) {
          for (const e of batch) {
            send(frame(e));
            cursor = e.sequence;
          }
          if (Date.now() - lastBeat >= heartbeatMs) {
            send(": hb\n\n");
            lastBeat = Date.now();
          }
          if (Date.now() - started >= maxMs) break;
          await new Promise((r) => setTimeout(r, pollMs));
          if (closed) break;
          const next = await h.getEvents(ownerId, workspaceId, cursor);
          if (next.status !== 200) break;
          batch = next.body.events;
        }
      } finally {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        close();
      }
    },
    cancel() {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      closed = true;
    }
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

// src/runtime/telemetry.ts
function createCompositeTelemetry(ports) {
  return {
    onActionStart(e) {
      for (const p of ports) p.onActionStart?.(e);
    },
    onActionEnd(e) {
      for (const p of ports) p.onActionEnd?.(e);
    },
    onTurnStart(e) {
      for (const p of ports) p.onTurnStart?.(e);
    },
    onTurnEnd(e) {
      for (const p of ports) p.onTurnEnd?.(e);
    }
  };
}
export {
  MemoryInteractionRepository,
  computePayloadHash,
  createCompositeTelemetry,
  createInteractionHandlers,
  createMemoryInteractionRepository,
  deterministicUuid,
  planActionCommit,
  planBatchActionCommit,
  runAssistantTurn,
  streamEvents,
  toErrorResult
};
//# sourceMappingURL=index.js.map
