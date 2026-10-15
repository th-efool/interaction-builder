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
var hostCommandEnvelopeSchema = z.strictObject({
  commandId: z.string().uuid(),
  ownerId: z.string().min(1).max(200),
  resourceId: z.string().min(1).max(200),
  expectedVersion: z.number().int().nonnegative(),
  readSet: z.array(entityRefSchema).max(100).optional(),
  command: z.unknown()
});
var hostCommandReceiptSchema = z.strictObject({
  receiptId: z.string().uuid(),
  commandId: z.string().uuid(),
  resourceId: z.string().min(1).max(200),
  resultingVersion: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
  changed: z.array(entityRefSchema).max(100),
  committedAt: z.string()
});
var hostResourceBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  resourceId: z.string().min(1).max(200),
  resourceKind: z.string().min(1).max(80),
  observedVersion: z.number().int().nonnegative(),
  selectedEntityId: z.string().nullable().optional()
});

// src/core/patch.ts
function unescapeJsonPointer(str) {
  return str.replace(/~1/g, "/").replace(/~0/g, "~");
}
function parsePointer(path) {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error(`Invalid JSON Pointer: "${path}"`);
  return path.slice(1).split("/").map(unescapeJsonPointer);
}
function applyJsonPatch(doc, patch) {
  let root = structuredClone(doc);
  for (const op of patch) {
    const tokens = parsePointer(op.path);
    if (tokens.length === 0) {
      if (op.op === "replace" || op.op === "add") {
        root = structuredClone(op.value);
        continue;
      }
      throw new Error(`Cannot perform op "${op.op}" on document root`);
    }
    let parent = root;
    for (let i = 0; i < tokens.length - 1; i++) {
      const key = tokens[i];
      if (parent === null || typeof parent !== "object") {
        throw new Error(`Cannot traverse path "${op.path}"`);
      }
      parent = parent[key];
    }
    const lastKey = tokens[tokens.length - 1];
    if (op.op === "add") {
      if (Array.isArray(parent)) {
        const index = lastKey === "-" ? parent.length : Number(lastKey);
        if (!Number.isInteger(index) || index < 0 || index > parent.length) {
          throw new Error(`Invalid array index "${lastKey}" for add`);
        }
        parent.splice(index, 0, structuredClone(op.value));
      } else if (parent && typeof parent === "object") {
        parent[lastKey] = structuredClone(op.value);
      } else {
        throw new Error(`Cannot add to non-object parent at "${op.path}"`);
      }
    } else if (op.op === "replace") {
      if (Array.isArray(parent)) {
        const index = Number(lastKey);
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
          throw new Error(`Invalid array index "${lastKey}" for replace`);
        }
        parent[index] = structuredClone(op.value);
      } else if (parent && typeof parent === "object") {
        if (!(lastKey in parent)) throw new Error(`Property "${lastKey}" not found for replace`);
        parent[lastKey] = structuredClone(op.value);
      }
    } else if (op.op === "remove") {
      if (Array.isArray(parent)) {
        const index = Number(lastKey);
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
          throw new Error(`Invalid array index "${lastKey}" for remove`);
        }
        parent.splice(index, 1);
      } else if (parent && typeof parent === "object") {
        if (!(lastKey in parent)) throw new Error(`Property "${lastKey}" not found for remove`);
        delete parent[lastKey];
      }
    } else if (op.op === "test") {
      const actual = parent?.[lastKey];
      if (JSON.stringify(actual) !== JSON.stringify(op.value)) {
        throw new Error(`Test operation failed at "${op.path}"`);
      }
    } else {
      throw new Error(`Unsupported JSON Patch operation: "${op.op}"`);
    }
  }
  return root;
}

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
    const payload = event.payload;
    if (payload?.patch && state.view) {
      try {
        const nextView = applyJsonPatch(state.view, payload.patch);
        return { ...state, sequence: event.sequence, revision: event.revision, view: nextView };
      } catch {
      }
    }
    if (payload?.snapshot !== void 0) {
      return { ...state, sequence: event.sequence, revision: event.revision, view: payload.snapshot };
    }
    return { ...state, sequence: event.sequence, revision: event.revision };
  }
  return { ...state, sequence: event.sequence };
}

// src/client/broadcast.ts
function createCrossTabCoordinator(opts) {
  const { workspaceId } = opts;
  const tabId = opts.tabId ?? (typeof crypto !== "undefined" ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  const heartbeatInterval = opts.heartbeatIntervalMs ?? 1e3;
  const leaderTimeout = opts.leaderTimeoutMs ?? 2500;
  if (typeof BroadcastChannel === "undefined") {
    return {
      isLeader: () => true,
      broadcastEvent: () => {
      },
      onEvent: () => () => {
      },
      onLeadershipChange: () => () => {
      },
      destroy: () => {
      }
    };
  }
  const channel = new BroadcastChannel(`ib:crosstab:${workspaceId}`);
  let leader = false;
  let leaderId = null;
  let lastHeartbeat = Date.now();
  let destroyed = false;
  let heartbeatTimer = null;
  let checkTimer = null;
  const eventListeners = /* @__PURE__ */ new Set();
  const leadershipListeners = /* @__PURE__ */ new Set();
  function notifyLeadership(next) {
    if (leader !== next) {
      leader = next;
      leadershipListeners.forEach((fn) => fn(leader));
    }
  }
  function assumeLeadership() {
    if (destroyed || leader) return;
    leaderId = tabId;
    notifyLeadership(true);
    startHeartbeat();
  }
  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (destroyed || !leader) return;
      channel.postMessage({
        type: "heartbeat",
        workspaceId,
        leaderId: tabId,
        timestamp: Date.now()
      });
    }, heartbeatInterval);
  }
  const initialDelay = 100 + Math.floor(Math.random() * 200);
  setTimeout(() => {
    if (destroyed) return;
    if (!leaderId) {
      assumeLeadership();
    }
  }, initialDelay);
  checkTimer = setInterval(() => {
    if (destroyed || leader) return;
    if (Date.now() - lastHeartbeat > leaderTimeout) {
      assumeLeadership();
    }
  }, leaderTimeout / 2);
  channel.onmessage = (ev) => {
    if (destroyed) return;
    const msg = ev.data;
    if (!msg || msg.workspaceId !== workspaceId) return;
    if (msg.type === "heartbeat") {
      lastHeartbeat = Date.now();
      if (msg.leaderId !== tabId) {
        leaderId = msg.leaderId;
        if (leader) {
          if (tabId > msg.leaderId) {
            clearInterval(heartbeatTimer);
            notifyLeadership(false);
          }
        }
      }
    } else if (msg.type === "yield") {
      if (leaderId === msg.leaderId) {
        leaderId = null;
        assumeLeadership();
      }
    } else if (msg.type === "event") {
      if (msg.tabId !== tabId) {
        eventListeners.forEach((fn) => fn(msg.event));
      }
    }
  };
  const handleUnload = () => {
    if (leader) {
      try {
        channel.postMessage({
          type: "yield",
          workspaceId,
          leaderId: tabId
        });
      } catch {
      }
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", handleUnload);
  }
  return {
    isLeader: () => leader,
    broadcastEvent(event) {
      if (destroyed) return;
      channel.postMessage({
        type: "event",
        workspaceId,
        tabId,
        event
      });
    },
    onEvent(handler) {
      eventListeners.add(handler);
      return () => eventListeners.delete(handler);
    },
    onLeadershipChange(handler) {
      leadershipListeners.add(handler);
      return () => leadershipListeners.delete(handler);
    },
    destroy() {
      destroyed = true;
      clearInterval(heartbeatTimer);
      clearInterval(checkTimer);
      handleUnload();
      if (typeof window !== "undefined") {
        window.removeEventListener("beforeunload", handleUnload);
      }
      channel.close();
    }
  };
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
  const maxReconnectDelay = opts.maxReconnectDelayMs ?? 1e4;
  const backoffMultiplier = opts.backoffMultiplier ?? 1.5;
  const withJitter = opts.jitter ?? true;
  const enableHistory = opts.enableHistory ?? true;
  const maxHistory = opts.maxHistory ?? 50;
  let state = {
    workspaceId,
    revision: 0,
    sequence: 0,
    view: opts.initialView,
    messages: [],
    connection: "connecting",
    pending: {},
    lastReceipt: null,
    lastError: null,
    isTimeTraveling: false
  };
  const subs = /* @__PURE__ */ new Set();
  let closeStream = null;
  let stopped = false;
  let resnapshotting = null;
  let resnapshotAgain = false;
  let timer = null;
  let reconnectAttempts = 0;
  const past = [];
  const future = [];
  let isTimeTraveling = false;
  let liveView = opts.initialView;
  let liveRevision = 0;
  let historySnapshot = {
    past: [],
    future: [],
    canUndo: false,
    canRedo: false,
    isTimeTraveling: false,
    activeRevision: state.revision
  };
  function updateHistorySnapshot() {
    historySnapshot = {
      past: [...past],
      future: [...future],
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      isTimeTraveling,
      activeRevision: state.revision
    };
  }
  function pushHistory(entry) {
    if (!enableHistory) return;
    past.push(entry);
    if (past.length > maxHistory) past.shift();
    future.length = 0;
    updateHistorySnapshot();
  }
  function recordViewAdvance(nextRev, nextView, summary, action) {
    if (nextRev > liveRevision) {
      pushHistory({
        revision: liveRevision,
        view: liveView,
        summary,
        action,
        timestamp: Date.now()
      });
      liveRevision = nextRev;
      liveView = nextView;
    }
  }
  let coordinator = null;
  if (opts.crossTabSync) {
    coordinator = createCrossTabCoordinator({ workspaceId });
    coordinator.onEvent((event) => {
      onServerEvent(event);
    });
    coordinator.onLeadershipChange((isLeader) => {
      if (isLeader) {
        open();
      } else {
        closeStream?.();
        closeStream = null;
      }
    });
  }
  const set = (next) => {
    const revChanged = state.revision !== next.revision || state.isTimeTraveling !== next.isTimeTraveling;
    state = next;
    if (revChanged) {
      updateHistorySnapshot();
    }
    subs.forEach((f) => f());
  };
  const apply = (e) => set({ ...state, ...reduceInteraction(state, e) });
  function resnapshot() {
    if (resnapshotting) {
      resnapshotAgain = true;
      return resnapshotting;
    }
    resnapshotting ??= transport.getWorkspace().then((s) => {
      if (s.revision >= state.revision) {
        viewRevision = s.revision;
        recordViewAdvance(s.revision, s.snapshot);
        if (!isTimeTraveling) {
          apply({
            kind: "snapshot",
            workspaceId,
            revision: s.revision,
            sequence: Math.max(s.cursor, state.sequence),
            view: s.snapshot,
            messages: s.messages ?? state.messages
          });
        }
      }
    }).finally(() => {
      resnapshotting = null;
      const again = resnapshotAgain;
      resnapshotAgain = false;
      if (again && !stopped && viewRevision < state.revision) {
        void resnapshot().catch(() => scheduleReopen());
      }
    });
    return resnapshotting;
  }
  function open() {
    if (stopped) return;
    if (coordinator && !coordinator.isLeader()) return;
    closeStream?.();
    closeStream = transport.openEvents(state.sequence, onServerEvent, onStreamClose);
  }
  function onServerEvent(event) {
    reconnectAttempts = 0;
    if (coordinator && coordinator.isLeader()) {
      coordinator.broadcastEvent(event);
    }
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
    if (coordinator && !coordinator.isLeader()) return;
    apply({ kind: "connection", value: "reconnecting" });
    const base = reconnectDelay * Math.pow(backoffMultiplier, reconnectAttempts);
    const capped = Math.min(maxReconnectDelay, base);
    const jitterFactor = withJitter ? 1 + (Math.random() * 0.3 - 0.15) : 1;
    const finalDelay = Math.max(1, Math.round(capped * jitterFactor));
    reconnectAttempts++;
    timer = setTimeout(() => {
      void resnapshot().catch(() => void 0).finally(open);
    }, finalDelay);
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
      reconnectAttempts = 0;
      const s = await transport.getWorkspace();
      viewRevision = s.revision;
      liveRevision = s.revision;
      liveView = s.snapshot;
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
      coordinator?.destroy();
      coordinator = null;
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
          recordViewAdvance(res.revision, res.snapshot, res.receipt.summary, action);
          set({
            ...state,
            revision: res.revision,
            view: res.snapshot,
            sequence: Math.max(state.sequence, res.cursor),
            pending: omit(state.pending, actionId),
            lastReceipt: { actionId, summary: res.receipt.summary },
            lastError: null,
            isTimeTraveling: false
          });
        } else {
          set({ ...state, pending: omit(state.pending, actionId) });
        }
        return true;
      } catch (e) {
        const code = e instanceof TransportError ? e.code : "NETWORK";
        if (code === "CONFLICT" && opts.conflictResolution === "rebase") {
          try {
            await resnapshot();
            let rebasedAction = action;
            if (opts.plan) {
              opts.plan(liveView, action, {
                actionId,
                workspaceId,
                expectedRevision: liveRevision,
                currentRevision: liveRevision,
                entityVersions: new Map(entityVersions.map((v) => [v.id, v.version]))
              });
            }
            const retryActionId = newId();
            const res = await transport.commit(
              { actionId: retryActionId, workspaceId, expectedRevision: liveRevision, entityVersions, action: rebasedAction },
              retryActionId
            );
            if (res.revision > liveRevision) {
              viewRevision = res.revision;
              recordViewAdvance(res.revision, res.snapshot, res.receipt.summary, action);
              set({
                ...state,
                revision: res.revision,
                view: res.snapshot,
                sequence: Math.max(state.sequence, res.cursor),
                pending: omit(state.pending, actionId),
                lastReceipt: { actionId: retryActionId, summary: res.receipt.summary },
                lastError: null,
                isTimeTraveling: false
              });
              return true;
            }
          } catch {
          }
        }
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
    },
    getHistory: () => historySnapshot,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undo() {
      if (past.length === 0) return false;
      const prev = past.pop();
      future.unshift({
        revision: state.revision,
        view: state.view,
        timestamp: Date.now()
      });
      isTimeTraveling = true;
      set({ ...state, revision: prev.revision, view: prev.view, isTimeTraveling: true });
      updateHistorySnapshot();
      return true;
    },
    redo() {
      if (future.length === 0) return false;
      const next = future.shift();
      past.push({
        revision: state.revision,
        view: state.view,
        timestamp: Date.now()
      });
      isTimeTraveling = next.revision !== liveRevision;
      set({ ...state, revision: next.revision, view: next.view, isTimeTraveling });
      updateHistorySnapshot();
      return true;
    },
    timeTravel(rev) {
      if (rev === state.revision) return true;
      if (rev === liveRevision) {
        isTimeTraveling = false;
        set({ ...state, revision: liveRevision, view: liveView, isTimeTraveling: false });
        updateHistorySnapshot();
        return true;
      }
      const match = past.find((e) => e.revision === rev) ?? future.find((e) => e.revision === rev);
      if (!match) return false;
      isTimeTraveling = true;
      set({ ...state, revision: match.revision, view: match.view, isTimeTraveling: true });
      updateHistorySnapshot();
      return true;
    },
    resetTimeTravel() {
      if (!isTimeTraveling) return;
      isTimeTraveling = false;
      set({ ...state, revision: liveRevision, view: liveView, isTimeTraveling: false });
      updateHistorySnapshot();
    },
    isCrossTabLeader: () => coordinator ? coordinator.isLeader() : true
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
      } else if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data: ")) {
        const chunk = line.slice(6);
        eventData = eventData.length > 0 ? eventData + "\n" + chunk : chunk;
      } else if (line.startsWith("data:")) {
        const chunk = line.slice(5);
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
      buffer += decoder.decode();
      if (buffer.length > 0) {
        buffer += "\n\n";
        processBuffer();
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
  createCrossTabCoordinator,
  createHttpTransport,
  createInteractionStore,
  parseSseStream
};
//# sourceMappingURL=index.js.map
