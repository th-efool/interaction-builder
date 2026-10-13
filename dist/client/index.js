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

// src/core/reducer.ts
function reduceInteraction(state, input) {
  if (input.kind === "snapshot") {
    if (input.workspaceId !== state.workspaceId) return state;
    return {
      ...state,
      revision: input.revision,
      sequence: input.sequence,
      view: input.view,
      messages: input.messages,
      connection: "live"
    };
  }
  if (input.kind === "request_pending") {
    return { ...state, pending: { ...state.pending, [input.actionId]: "pending" } };
  }
  if (input.kind === "request_failed") {
    const pending = { ...state.pending, [input.actionId]: "failed" };
    return { ...state, pending };
  }
  if (input.kind === "connection") {
    return { ...state, connection: input.value };
  }
  const parsed = interactionEventSchema.safeParse(input.event);
  if (!parsed.success || parsed.data.workspaceId !== state.workspaceId) return state;
  const event = parsed.data;
  if (event.sequence <= state.sequence) return state;
  if (event.sequence !== state.sequence + 1) {
    return { ...state, connection: "reset_required" };
  }
  if (event.type === "message.accepted" && event.payload?.message) {
    const msg = event.payload.message;
    const messages = state.messages.some((m) => m.id === msg.id) ? state.messages : [...state.messages, msg];
    return { ...state, sequence: event.sequence, messages };
  }
  if (event.type === "workspace.committed" && event.revision !== void 0) {
    return { ...state, sequence: event.sequence, revision: event.revision };
  }
  return { ...state, sequence: event.sequence };
}

// src/client/store.ts
var TransportError = class extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
  status;
  code;
};
function createInteractionStore(opts) {
  const { workspaceId, transport } = opts;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const reconnectDelay = opts.reconnectDelayMs ?? 500;
  let state = {
    workspaceId,
    revision: 0,
    sequence: 0,
    view: opts.initialView,
    messages: [],
    connection: "connecting",
    pending: {},
    lastReceipt: null,
    lastError: null
  };
  const subs = /* @__PURE__ */ new Set();
  let closeStream = null;
  let stopped = false;
  let resnapshotting = null;
  let timer = null;
  const set = (next) => {
    state = next;
    subs.forEach((f) => f());
  };
  const apply = (e) => set({ ...state, ...reduceInteraction(state, e) });
  function resnapshot() {
    resnapshotting ??= transport.getWorkspace().then((s) => {
      if (s.revision >= state.revision) {
        viewRevision = s.revision;
        apply({
          kind: "snapshot",
          workspaceId,
          revision: s.revision,
          sequence: Math.max(s.cursor, state.sequence),
          view: s.snapshot,
          messages: s.messages ?? state.messages
        });
      }
    }).finally(() => {
      resnapshotting = null;
    });
    return resnapshotting;
  }
  function open() {
    if (stopped) return;
    closeStream?.();
    closeStream = transport.openEvents(state.sequence, onServerEvent, onStreamClose);
  }
  function onServerEvent(event) {
    const before = state;
    apply({ kind: "server", event });
    if (state.connection === "reset_required") {
      void resnapshot().then(open).catch(() => scheduleReopen());
      return;
    }
    if (state.revision > before.revision && event.type === "workspace.committed" && !viewCoversRevision(state.revision)) {
      void resnapshot().catch(() => void 0);
    }
  }
  let viewRevision = 0;
  const viewCoversRevision = (rev) => rev <= viewRevision;
  function scheduleReopen() {
    if (stopped) return;
    apply({ kind: "connection", value: "reconnecting" });
    timer = setTimeout(() => {
      void resnapshot().catch(() => void 0).finally(open);
    }, reconnectDelay);
  }
  function onStreamClose() {
    if (!stopped) scheduleReopen();
  }
  return {
    getState: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    async connect() {
      stopped = false;
      const s = await transport.getWorkspace();
      viewRevision = s.revision;
      apply({
        kind: "snapshot",
        workspaceId,
        revision: s.revision,
        sequence: s.cursor,
        view: s.snapshot,
        messages: s.messages ?? []
      });
      open();
    },
    disconnect() {
      stopped = true;
      if (timer) clearTimeout(timer);
      closeStream?.();
      closeStream = null;
    },
    async dispatchAction(action, entityVersions = []) {
      const actionId = newId();
      apply({ kind: "request_pending", actionId });
      try {
        const res = await transport.commit(
          { actionId, workspaceId, expectedRevision: state.revision, entityVersions, action },
          actionId
        );
        if (res.revision > state.revision) {
          viewRevision = res.revision;
          set({
            ...state,
            revision: res.revision,
            view: res.snapshot,
            sequence: Math.max(state.sequence, res.cursor),
            pending: omit(state.pending, actionId),
            lastReceipt: { actionId, summary: res.receipt.summary },
            lastError: null
          });
        } else {
          set({ ...state, pending: omit(state.pending, actionId) });
        }
        return true;
      } catch (e) {
        const code = e instanceof TransportError ? e.code : "NETWORK";
        apply({ kind: "request_failed", actionId });
        set({ ...state, lastError: { actionId, code } });
        if (code === "CONFLICT") void resnapshot().catch(() => void 0);
        return false;
      }
    },
    async sendMessage(parts) {
      const messageId = newId();
      if (!transport.sendMessage) return false;
      try {
        await transport.sendMessage({ id: messageId, parts }, messageId);
        return true;
      } catch (e) {
        const code = e instanceof TransportError ? e.code : "NETWORK";
        set({ ...state, lastError: { actionId: messageId, code } });
        return false;
      }
    },
    async runAssistant() {
      if (!transport.runAssistant) return false;
      try {
        await transport.runAssistant();
        return true;
      } catch {
        return false;
      }
    }
  };
}
function omit(o, k) {
  const { [k]: _drop, ...rest } = o;
  return rest;
}

// src/client/transport.ts
function parseSseStream(stream, onEvent, onClose) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventType = "";
  let eventData = "";
  function processBuffer() {
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      let line = buffer.slice(0, newlineIndex);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      buffer = buffer.slice(newlineIndex + 1);
      if (line === "") {
        if (eventData.length > 0) {
          try {
            const parsed = JSON.parse(eventData);
            onEvent(parsed);
          } catch {
          }
          eventData = "";
          eventType = "";
        }
      } else if (line.startsWith(":")) {
      } else if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const chunk = line.slice(6);
        eventData = eventData.length > 0 ? eventData + "\n" + chunk : chunk;
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          processBuffer();
        }
      }
    } catch {
    } finally {
      onClose();
    }
  })();
}
function createHttpTransport(opts) {
  const baseUrl = (opts.baseUrl ?? "/api/interaction/v1").replace(/\/+$/, "");
  const workspaceId = opts.workspaceId;
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async getWorkspace() {
      const res = await doFetch(`${baseUrl}/workspaces/${workspaceId}`, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      if (!res.ok) {
        let code = "NETWORK_ERROR";
        try {
          const body2 = await res.json();
          if (body2?.code) code = body2.code;
        } catch {
        }
        throw new TransportError(res.status, code);
      }
      const body = await res.json();
      return body;
    },
    async commit(envelope, idempotencyKey) {
      const res = await doFetch(`${baseUrl}/workspaces/${workspaceId}/actions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        },
        body: JSON.stringify(envelope)
      });
      if (!res.ok) {
        let code = "INVALID_ACTION";
        try {
          const body2 = await res.json();
          if (body2?.code) code = body2.code;
        } catch {
        }
        throw new TransportError(res.status, code);
      }
      const body = await res.json();
      return body;
    },
    async sendMessage(message, idempotencyKey) {
      const res = await doFetch(`${baseUrl}/workspaces/${workspaceId}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        },
        body: JSON.stringify(message)
      });
      if (!res.ok) {
        let code = "INVALID_ACTION";
        try {
          const body2 = await res.json();
          if (body2?.code) code = body2.code;
        } catch {
        }
        throw new TransportError(res.status, code);
      }
      const body = await res.json();
      return body;
    },
    async runAssistant() {
      const res = await doFetch(`${baseUrl}/workspaces/${workspaceId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      if (!res.ok) {
        let code = "NETWORK_ERROR";
        try {
          const body2 = await res.json();
          if (body2?.code) code = body2.code;
        } catch {
        }
        throw new TransportError(res.status, code);
      }
      const body = await res.json();
      return body;
    },
    openEvents(cursor, onEvent, onClose) {
      const controller = new AbortController();
      void (async () => {
        try {
          const res = await doFetch(`${baseUrl}/workspaces/${workspaceId}/events?after=${cursor}`, {
            method: "GET",
            headers: {
              accept: "text/event-stream",
              "last-event-id": String(cursor)
            },
            signal: controller.signal
          });
          if (!res.ok || !res.body) {
            onClose();
            return;
          }
          parseSseStream(res.body, onEvent, onClose);
        } catch {
          onClose();
        }
      })();
      return () => {
        controller.abort();
      };
    }
  };
}
export {
  TransportError,
  createHttpTransport,
  createInteractionStore,
  parseSseStream
};
//# sourceMappingURL=index.js.map
