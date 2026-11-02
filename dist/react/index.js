'use client';
// src/react/provider.tsx
import { createContext, useContext, useEffect, useMemo, useRef } from "react";

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
    revision: opts.initialRevision ?? 0,
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
  let liveRevision = opts.initialRevision ?? 0;
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
  let viewRevision = opts.initialRevision ?? 0;
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
      if (opts.initialView !== void 0 && opts.initialRevision !== void 0) {
        viewRevision = opts.initialRevision;
        liveRevision = opts.initialRevision;
        liveView = opts.initialView;
        apply({
          kind: "snapshot",
          workspaceId,
          revision: opts.initialRevision,
          sequence: 0,
          view: opts.initialView,
          messages: []
        });
        open();
      } else {
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
      }
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
      let optimisticApplied = false;
      const priorState = state;
      if (opts.plan && !isTimeTraveling) {
        try {
          const planResult = opts.plan(state.view, action, {
            actionId,
            workspaceId,
            expectedRevision: state.revision,
            currentRevision: state.revision,
            entityVersions: new Map(entityVersions.map((v) => [v.id, v.version]))
          });
          if (planResult && planResult.nextState) {
            optimisticApplied = true;
            set({
              ...state,
              view: planResult.nextState,
              pending: { ...state.pending, [actionId]: "pending" }
            });
          }
        } catch {
        }
      }
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
          set({
            ...state,
            view: res.snapshot ?? state.view,
            pending: omit(state.pending, actionId)
          });
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
        if (optimisticApplied) {
          set({
            ...priorState,
            pending: { ...priorState.pending, [actionId]: "failed" },
            lastError: { actionId, code }
          });
        } else {
          apply({ kind: "request_failed", actionId });
          set({ ...state, lastError: { actionId, code } });
        }
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

// src/react/provider.tsx
import { jsx } from "react/jsx-runtime";
var InteractionContext = createContext(null);
function InteractionProvider({
  workspaceId,
  initialView,
  transport,
  store: externalStore,
  children
}) {
  const effectiveTransport = useMemo(() => {
    if (externalStore) return void 0;
    return transport ?? createHttpTransport({ workspaceId });
  }, [transport, workspaceId, externalStore]);
  const internalStore = useMemo(() => {
    if (externalStore) return externalStore;
    if (!workspaceId) throw new Error('InteractionProvider requires either "store" or "workspaceId" and "initialView"');
    return createInteractionStore({
      workspaceId,
      initialView,
      transport: effectiveTransport
    });
  }, [externalStore, workspaceId, initialView, effectiveTransport]);
  const store = externalStore ?? internalStore;
  const connectedRef = useRef(false);
  useEffect(() => {
    if (!connectedRef.current) {
      connectedRef.current = true;
      void store.connect();
    }
    return () => {
      store.disconnect();
      connectedRef.current = false;
    };
  }, [store]);
  return /* @__PURE__ */ jsx(InteractionContext.Provider, { value: store, children });
}
function useInteractionStore() {
  const store = useContext(InteractionContext);
  if (!store) {
    throw new Error("useInteractionStore must be used within an InteractionProvider");
  }
  return store;
}

// src/react/hooks.ts
import { useCallback, useRef as useRef2, useSyncExternalStore } from "react";
function useInteractionState() {
  const store = useInteractionStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState
  );
}
function useInteractionSelector(selector, isEqual = Object.is) {
  const store = useInteractionStore();
  const selectorRef = useRef2(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef2(isEqual);
  isEqualRef.current = isEqual;
  const cacheRef = useRef2({
    initialized: false,
    value: void 0
  });
  const getSnapshot = useCallback(() => {
    const nextValue = selectorRef.current(store.getState().view);
    if (cacheRef.current.initialized && isEqualRef.current(cacheRef.current.value, nextValue)) {
      return cacheRef.current.value;
    }
    cacheRef.current = { initialized: true, value: nextValue };
    return nextValue;
  }, [store]);
  return useSyncExternalStore(
    store.subscribe,
    getSnapshot,
    getSnapshot
  );
}
function useWorkspaceView() {
  const state = useInteractionState();
  return state.view;
}
function useWorkspaceMessages() {
  const state = useInteractionState();
  return state.messages;
}
function useWorkspaceConnection() {
  const state = useInteractionState();
  return state.connection;
}
function useWorkspacePending() {
  const state = useInteractionState();
  return state.pending;
}
function useDispatchAction() {
  const store = useInteractionStore();
  return useCallback(
    (action, entityVersions) => {
      return store.dispatchAction(action, entityVersions);
    },
    [store]
  );
}
function useSendMessage() {
  const store = useInteractionStore();
  return useCallback(
    async (text, entityRefs = []) => {
      const trimmed = text.trim();
      if (!trimmed && entityRefs.length === 0) return false;
      const parts = [];
      if (trimmed) {
        parts.push({ type: "text", text: trimmed });
      }
      for (const ref of entityRefs) {
        parts.push({ type: "entity_ref", entity: ref.entity, label: ref.label });
      }
      return store.sendMessage(parts);
    },
    [store]
  );
}
function useRunAssistant() {
  const store = useInteractionStore();
  return useCallback(() => {
    return store.runAssistant();
  }, [store]);
}
function useInteractionHistory() {
  const store = useInteractionStore();
  const history = useSyncExternalStore(
    store.subscribe,
    store.getHistory,
    store.getHistory
  );
  return {
    ...history,
    undo: useCallback(() => store.undo(), [store]),
    redo: useCallback(() => store.redo(), [store]),
    timeTravel: useCallback((revision) => store.timeTravel(revision), [store]),
    resetTimeTravel: useCallback(() => store.resetTimeTravel(), [store])
  };
}
function useIsCrossTabLeader() {
  const store = useInteractionStore();
  const getLeader = useCallback(() => store.isCrossTabLeader ? store.isCrossTabLeader() : true, [store]);
  return useSyncExternalStore(
    store.subscribe,
    getLeader,
    () => true
  );
}

// src/react/progress-ui.tsx
import { useCallback as useCallback2, useEffect as useEffect2, useMemo as useMemo2, useRef as useRef3, useState } from "react";

// src/core/progress-ux.ts
function hashSeed(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function pickDeterministic(items, seed, offset = 0) {
  const index = Math.abs(seed + offset * 7919) % items.length;
  return items[index];
}
function formatShortTopic(raw, maxLength = 34) {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLength - 3)).trimEnd()}\u2026`;
}
var DEFAULT_STEP_COUNTS = [2, 3, 4, 5, 3, 4, 2, 5];
function pickStepCount(seed, allowedCounts = DEFAULT_STEP_COUNTS) {
  const list = allowedCounts.length > 0 ? allowedCounts : DEFAULT_STEP_COUNTS;
  return list[seed % list.length];
}
function interpolateTopic(template, topic, fallbackTopic = "your request") {
  return template.replace(/\{\{topic\}\}/g, topic || fallbackTopic);
}
var DEFAULT_GENERAL_POOLS = {
  stage1: [
    "Processing your query",
    "Reading your message",
    "Tuning in to your question",
    "Unpacking your thought"
  ],
  stage2: [
    "Mapping concepts around {{topic}}",
    "Exploring foundational mental models",
    "Structuring a clear pathway",
    "Identifying high-impact focus areas"
  ],
  stage3: [
    "Connecting context to practical actions",
    "Sequencing milestones from the ground up",
    "Curating relevant angles & examples"
  ],
  stage4: [
    "Tailoring depth & structure",
    "Calibrating recommendations to your goal",
    "Sharpening key takeaways"
  ],
  stage5: [
    "Drafting tailored response",
    "Putting together your action plan",
    "Weaving everything into a clear reply"
  ]
};
function buildVariedSteps({
  seedKey,
  topic,
  isActive,
  activePhaseIndex,
  minRunningIndex = 0,
  idPrefix = "ib-step",
  pools = DEFAULT_GENERAL_POOLS,
  allowedCounts
}) {
  const shortTopic = formatShortTopic(topic);
  const seed = hashSeed(seedKey);
  const count = pickStepCount(seed, allowedCounts);
  const stageArray = [
    pools.stage1,
    pools.stage2,
    pools.stage3,
    pools.stage4,
    pools.stage5
  ];
  let selectedPoolIndices;
  if (count === 2) {
    selectedPoolIndices = [0, 4];
  } else if (count === 3) {
    selectedPoolIndices = [0, 1, 4];
  } else if (count === 4) {
    selectedPoolIndices = [0, 1, 2, 4];
  } else {
    selectedPoolIndices = [0, 1, 2, 3, 4];
  }
  const runningIdx = Math.min(
    Math.max(minRunningIndex, activePhaseIndex),
    selectedPoolIndices.length - 1
  );
  return selectedPoolIndices.map((poolIdx, idx) => {
    const rawTemplate = pickDeterministic(stageArray[poolIdx], seed, idx + 1);
    const label = interpolateTopic(rawTemplate, shortTopic, "your goal");
    if (!isActive) {
      return { id: `${idPrefix}-${idx}`, label, state: "complete" };
    }
    const state = idx < runningIdx ? "complete" : idx === runningIdx ? "running" : "pending";
    return {
      id: `${idPrefix}-${idx}`,
      label,
      state
    };
  });
}
function buildVariedSearchSteps({
  goal,
  query,
  intentVersion = 0,
  isSearching,
  activePhaseIndex,
  resourcePlural = "cohorts"
}) {
  const rawTopic = query?.trim() || goal?.trim() || "";
  const shortTopic = formatShortTopic(rawTopic);
  const seed = hashSeed(`search::${rawTopic.toLowerCase()}::${intentVersion}::${resourcePlural}`);
  const count = pickStepCount(seed);
  const stage1Pool = shortTopic ? [
    `Reading your prompt on ${shortTopic}`,
    `Unpacking "${shortTopic}"`,
    `Parsing your interest in ${shortTopic}`,
    `Tuning in to ${shortTopic}`,
    `Capturing your learning focus`,
    `Processing your query`
  ] : [
    "Processing your query",
    "Reading your learning prompt",
    "Unpacking what you want to explore",
    "Capturing your curiosity",
    "Parsing your topic focus"
  ];
  const stage2Pool = shortTopic ? [
    `Mapping key concepts in ${shortTopic}`,
    `Understanding your learning goal`,
    `Identifying core pillars for ${shortTopic}`,
    `Scoping skill depth & prerequisites`,
    `Framing a study trajectory for ${shortTopic}`,
    `Distilling key themes & milestones`
  ] : [
    "Understanding your learning goal",
    "Mapping core concepts & skill depth",
    "Identifying foundational pillars",
    "Scoping a practical learning arc",
    "Distilling key study themes"
  ];
  const stage3Pool = shortTopic ? [
    `Scanning live ${resourcePlural} for ${shortTopic}`,
    `Searching community ${resourcePlural} for matches`,
    `Looking for active ${shortTopic} study groups`,
    `Checking ongoing peer ${resourcePlural} & syllabi`,
    `Exploring public ${resourcePlural} in this space`
  ] : [
    `Searching ${resourcePlural} for you`,
    `Scanning active community ${resourcePlural}`,
    `Looking for matching study groups`,
    `Checking live peer ${resourcePlural} & syllabi`,
    `Exploring public learning ${resourcePlural}`
  ];
  const stage4Pool = [
    "Comparing curriculum depth & pacing",
    "Filtering by topic relevance & structure",
    `Ranking the closest ${resourcePlural.replace(/s$/, "")} matches`,
    "Checking studio templates & starting paths",
    "Weighing peer group fit & study rhythm"
  ];
  const stage5Pool = [
    "Preparing your workspace canvas",
    "Lining up recommendations & studio tools",
    "Setting up your studio view",
    "Finalizing matches & next steps",
    "Opening your tailored workspace"
  ];
  let selectedLabels;
  if (count === 2) {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage3Pool, seed, 2)
    ];
  } else if (count === 3) {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage2Pool, seed, 2),
      pickDeterministic(stage3Pool, seed, 3)
    ];
  } else if (count === 4) {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage2Pool, seed, 2),
      pickDeterministic(stage3Pool, seed, 3),
      pickDeterministic(stage5Pool, seed, 4)
    ];
  } else {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage2Pool, seed, 2),
      pickDeterministic(stage3Pool, seed, 3),
      pickDeterministic(stage4Pool, seed, 4),
      pickDeterministic(stage5Pool, seed, 5)
    ];
  }
  const runningIdx = Math.min(Math.max(1, activePhaseIndex), selectedLabels.length - 1);
  return selectedLabels.map((label, idx) => {
    if (!isSearching) {
      return { id: `search-step-${idx}`, label, state: "complete" };
    }
    const state = idx < runningIdx ? "complete" : idx === runningIdx ? "running" : "pending";
    return {
      id: `search-step-${idx}`,
      label,
      state
    };
  });
}
function buildVariedTurnSteps({
  latestUserText,
  goal,
  step,
  hasLessons = false,
  runId,
  activePhaseIndex
}) {
  const trimmed = latestUserText.trim();
  const shortTopic = formatShortTopic(goal || trimmed);
  const seed = hashSeed(`turn::${trimmed.toLowerCase()}::${step ?? ""}::${runId ?? ""}`);
  const count = pickStepCount(seed);
  const isCohortStart = /\b(?:start|create|build|make|launch)\b.*\b(?:cohort|course|curriculum|studio|workspace|project)\b|\bcreate\s+my\s+own\b/i.test(trimmed);
  const isCohortSearch = /\b(?:search|find|look\s+for|similar|browse)\b.*\b(?:cohorts?|courses?|projects?|templates?)\b/i.test(trimmed);
  const isNextStepsQuery = /\b(?:what\s+should\s+i\s+do|where\s+do\s+i\s+start|how\s+do\s+i\s+start|what\s+now|next\s+step|help\s+me\s+start)\b/i.test(trimmed);
  let pool;
  if (isCohortStart) {
    pool = [
      ["Reading your studio request", "Noting your cohort preferences", "Locking in your cohort direction"],
      ["Preparing cohort creation studio", "Configuring your curriculum workspace", "Spinning up the studio canvas"],
      ["Structuring starting options", "Setting up material & goal pathways", "Aligning study pacing defaults"],
      ["Opening cohort studio", "Launching your builder workspace", "Handing off to the studio canvas"],
      ["Drafting your kickoff guide", "Putting together initial suggestions", "Ready to build together"]
    ];
  } else if (isCohortSearch) {
    pool = [
      ["Reading your search refinement", "Parsing your updated criteria", "Checking your topic filters"],
      ["Understanding your learning goal", "Mapping related subject areas", "Scoping target skill level"],
      ["Looking for similar cohorts", "Scanning community study groups", "Searching public cohort directory"],
      ["Comparing cohort syllabi & pacing", "Filtering closest topic matches", "Weighing curriculum overlap"],
      ["Summarizing cohort options", "Preparing recommendations", "Wrapping up search insights"]
    ];
  } else if (isNextStepsQuery) {
    pool = [
      ["Checking where we are in your studio", "Reading your question", "Reviewing your current workspace state"],
      [
        shortTopic ? `Looking at your ${shortTopic} goal` : "Reviewing your learning goal",
        "Evaluating the best starting angle",
        "Mapping practical first milestones"
      ],
      ["Sketching a clear action plan", "Weighing self-paced vs. source-led paths", "Organizing concrete next steps"],
      ["Tailoring recommendations to your pace", "Picking the highest-leverage first move", "Structuring a week-by-week preview"],
      ["Drafting your next-steps guide", "Putting together clear options", "Polishing your roadmap advice"]
    ];
  } else if (step === "review" || step === "ready" || hasLessons) {
    pool = [
      ["Reading your curriculum feedback", "Parsing your adjustment request", "Checking your lesson notes"],
      ["Reviewing your curriculum structure", "Inspecting current questline modules", "Scanning lesson objectives & flow"],
      ["Evaluating pacing & topic sequence", "Aligning module depth with your goal", "Checking prerequisite transitions"],
      ["Refining lesson breakdown", "Updating syllabus recommendations", "Polishing module takeaways"],
      ["Drafting tailored response", "Summarizing curriculum updates", "Preparing your updated plan"]
    ];
  } else if (step === "material_input" || step === "discovery") {
    pool = [
      ["Reading your source notes", "Parsing your material preferences", "Capturing your reference criteria"],
      ["Analyzing your learning sources", "Scanning source coverage & depth", "Extracting core concepts from materials"],
      ["Connecting sources to your study goal", "Mapping readings to practical milestones", "Identifying high-signal sections"],
      ["Structuring source-backed takeaways", "Organizing reference highlights", "Weighing source difficulty"],
      ["Drafting tailored response", "Synthesizing source insights", "Preparing your study breakdown"]
    ];
  } else {
    pool = [
      ["Processing your query", "Reading your message", "Tuning in to your question", "Unpacking your thought"],
      [
        shortTopic ? `Mapping concepts around ${shortTopic}` : "Mapping your learning pathway",
        "Exploring foundational mental models",
        "Structuring a clear learning arc",
        "Identifying high-impact subtopics"
      ],
      ["Connecting theory to hands-on practice", "Sequencing milestones from basics up", "Curating practical study angles"],
      ["Tailoring depth & weekly rhythm", "Calibrating examples to your goal", "Sharpening key takeaways"],
      ["Drafting tailored response", "Putting together your learning plan", "Weaving everything into a clear reply"]
    ];
  }
  let stageIndices;
  if (count === 2) {
    stageIndices = [0, 4];
  } else if (count === 3) {
    stageIndices = [0, 1, 4];
  } else if (count === 4) {
    stageIndices = [0, 1, 2, 4];
  } else {
    stageIndices = [0, 1, 2, 3, 4];
  }
  const runningIdx = Math.min(Math.max(0, activePhaseIndex), stageIndices.length - 1);
  return stageIndices.map((poolIdx, idx) => {
    const label = pickDeterministic(pool[poolIdx], seed, idx + 1);
    const state = idx < runningIdx ? "complete" : idx === runningIdx ? "running" : "pending";
    return {
      id: `turn-step-${idx}`,
      label,
      state
    };
  });
}
function buildVariedSearchSummary({
  goal,
  step,
  status,
  matchCount,
  intentVersion = 0,
  isSearching,
  createCtaLabel = "Create your own cohort",
  resourceSingular = "cohort",
  resourcePlural = "cohorts"
}) {
  if (isSearching) return null;
  const topicLabel = goal?.trim() || "your learning goal";
  const seed = hashSeed(`summary::${topicLabel.toLowerCase()}::${step ?? ""}::${status ?? ""}::${matchCount}::${intentVersion}`);
  if (step === "recommendations") {
    if (status === "failed") {
      const failedTemplates = [
        `I hit a snag while checking public ${resourcePlural} for **${topicLabel}**. I\u2019ve opened the studio panel on the right so you can retry the search or jump straight into **${createCtaLabel}**.`,
        `I couldn\u2019t finish searching public ${resourcePlural} for **${topicLabel}** just now. You can retry from the right-hand panel or click **${createCtaLabel}** to start building right away.`,
        `Our ${resourceSingular} directory didn\u2019t respond in time for **${topicLabel}**, so I\u2019ve opened the studio on the right \u2014 feel free to retry the search or spin up your own custom ${resourceSingular}!`,
        `Something interrupted the ${resourceSingular} lookup for **${topicLabel}**. No worries \u2014 the workspace on the right is open so you can retry or click **${createCtaLabel}** to design your own plan.`
      ];
      return pickDeterministic(failedTemplates, seed);
    }
    if (matchCount > 0) {
      const noun = matchCount === 1 ? resourceSingular : resourcePlural;
      const pron = matchCount === 1 ? "it" : "them";
      const matchTemplates = [
        `I found **${matchCount}** matching community ${noun} for **${topicLabel}** and lined ${pron} up on the right. Browse the matches to join one, or click **${createCtaLabel}** to craft a custom syllabus.`,
        `Good news \u2014 there ${matchCount === 1 ? "is" : "are"} **${matchCount}** active community ${noun} around **${topicLabel}**! Check ${pron} out in the right panel, or hit **${createCtaLabel}** if you want a tailored plan.`,
        `I\u2019ve pulled up **${matchCount}** public ${noun} related to **${topicLabel}** on the right. You can hop into an existing group or click **${createCtaLabel}** to build from scratch.`,
        `We spotted **${matchCount}** community ${noun} exploring **${topicLabel}**! Take a look on the right to see if the pacing fits, or choose **${createCtaLabel}** to design your own journey.`,
        `I scanned our directory for **${topicLabel}** and found **${matchCount}** matching ${noun} (now open on the right). Join a group that resonates, or start fresh with **${createCtaLabel}**.`,
        `There ${matchCount === 1 ? "is" : "are"} **${matchCount}** peer ${noun} for **${topicLabel}** ready to explore on the right. Feel free to join ${pron}, or tell me here how you\u2019d like to customize your own ${resourceSingular}!`
      ];
      return pickDeterministic(matchTemplates, seed);
    }
    const zeroMatchTemplates = [
      `I searched our public ${resourcePlural} for **${topicLabel}**, and no matching community ${resourcePlural} exist yet. I\u2019ve opened the studio on the right \u2014 click **${createCtaLabel}** (or tell me here how you\u2019d like to start) to launch the first one!`,
      `No one has launched a public ${resourceSingular} for **${topicLabel}** yet \u2014 which means you get to pioneer it! Use **${createCtaLabel}** on the right, or tell me your goals here and we\u2019ll sketch the syllabus together.`,
      `I checked our active directory for **${topicLabel}** and came up empty on existing groups. I\u2019ve popped open the builder on the right so you can click **${createCtaLabel}** and shape a custom study plan.`,
      `It looks like **${topicLabel}** is fresh territory in our community ${resourcePlural}! Head over to the panel on the right and hit **${createCtaLabel}**, or reply here with what you want to cover first.`,
      `We don\u2019t have a live community ${resourceSingular} for **${topicLabel}** right now, so I\u2019ve set up the studio on the right for you. Click **${createCtaLabel}** to kick one off \u2014 or ask me to draft a learning roadmap here!`,
      `Zero public ${resourcePlural} matched **${topicLabel}** so far. Let\u2019s build one tailored to you: click **${createCtaLabel}** on the right canvas, or share your background here to get started.`,
      `I scanned our community ${resourcePlural} for **${topicLabel}**, and none are running yet. You can be the first \u2014 click **${createCtaLabel}** on the right or tell me what materials and goals you have in mind!`,
      `No active ${resourcePlural} matched **${topicLabel}** today, so I opened the studio canvas on the right. Hit **${createCtaLabel}** to design your own track, or chat with me here to brainstorm modules!`
    ];
    return pickDeterministic(zeroMatchTemplates, seed);
  }
  const studioOpenedTemplates = [
    `I\u2019ve opened the ${resourceSingular} studio on the right for **${topicLabel}**. Choose your starting point on the canvas or tell me what materials and goals you have in mind!`,
    `Your ${resourceSingular} studio for **${topicLabel}** is live on the right! Pick a starting path on the canvas, or tell me here how you\u2019d like to structure your learning.`,
    `We checked existing ${resourcePlural} for **${topicLabel}** and opened your builder workspace on the right. Select how you want to begin on the canvas, or chat with me here to shape your plan!`,
    `I\u2019ve set up the studio canvas on the right for **${topicLabel}**. You can bring your own sources, let us find materials, or ask me here to sketch an initial roadmap.`,
    `Ready to build your **${topicLabel}** ${resourceSingular}! Use the studio controls on the right to pick your starting point, or tell me about your background and timeline right here.`
  ];
  return pickDeterministic(studioOpenedTemplates, seed);
}
function hasUnansweredInitialUserPrompt(messages) {
  return messages.length > 0 && messages[0]?.role === "user" && (!messages[1] || messages[1].role === "user");
}
function resolveActivityAnchorMessageId(messages, showActivityBubble) {
  if (!showActivityBubble || messages.length === 0) return null;
  if (hasUnansweredInitialUserPrompt(messages)) {
    return messages[0].id;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      return messages[i].id;
    }
  }
  return messages[messages.length - 1].id;
}
function isAnchoredBubbleAtConversationEnd(messages, showActivityBubble, anchorMessageId) {
  if (!showActivityBubble) return false;
  const latest = messages[messages.length - 1];
  return !anchorMessageId || latest?.id === anchorMessageId;
}
function createImplicitActionDetector(rules) {
  return (text, currentStage) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    for (const rule of rules) {
      if (rule.allowedStages && rule.allowedStages.length > 0) {
        if (currentStage === void 0 || !rule.allowedStages.includes(currentStage)) {
          continue;
        }
      }
      if ((rule.ignoreQuestions ?? true) && trimmed.endsWith("?")) {
        continue;
      }
      for (const pattern of rule.patterns) {
        if (pattern.test(trimmed)) {
          return typeof rule.action === "function" ? rule.action(trimmed) : rule.action;
        }
      }
    }
    return null;
  };
}
function resolveSplitCanvasLayout({
  stage,
  centeredStages = ["chat"],
  discoveryStage = "recommendations",
  discoveryStatus
}) {
  if (!stage) return "split";
  if (centeredStages.includes(stage)) return "centered";
  if (stage === discoveryStage && (!discoveryStatus || discoveryStatus === "queued" || discoveryStatus === "running")) {
    return "centered";
  }
  return "split";
}
function createStageSuggestions(map, maxSuggestions = 3) {
  return (stage, ctx) => {
    const entry = (stage ? map[stage] : void 0) ?? map.default;
    if (!entry) return [];
    const list = typeof entry === "function" ? entry(ctx) : entry;
    return list.slice(0, maxSuggestions);
  };
}

// src/react/progress-ui.tsx
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
var DEFAULT_LIST_STYLE = {
  listStyle: "none",
  margin: "2px 0 11px 2px",
  padding: "2px 0 2px 12px",
  display: "flex",
  flexDirection: "column",
  gap: "7px",
  borderLeft: "1.5px solid var(--ib-step-line, rgba(130, 140, 160, 0.28))"
};
function getDefaultItemStyle(state) {
  return {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    margin: 0,
    fontSize: "12.75px",
    lineHeight: 1.35,
    opacity: state === "pending" ? 0.52 : 1,
    fontWeight: state === "running" ? 560 : state === "complete" ? 480 : 400,
    color: state === "running" ? "var(--ib-step-ink, #08143d)" : "var(--ib-step-muted, #5d6f8c)",
    transition: "color 0.2s ease, opacity 0.2s ease"
  };
}
function getDefaultMarkerStyle(state) {
  return {
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    border: state === "pending" ? "1.25px solid rgba(93, 111, 140, 0.38)" : "1.25px solid rgba(48, 60, 255, 0.30)",
    background: state === "pending" ? "transparent" : "rgba(48, 60, 255, 0.11)",
    color: "var(--ib-step-accent, #303cff)"
  };
}
function InteractionStepTrail({
  steps,
  ariaLabel = "Assistant progress steps",
  classNames,
  useDefaultInlineStyles = !classNames?.list
}) {
  return /* @__PURE__ */ jsx2(
    "ol",
    {
      className: classNames?.list,
      style: useDefaultInlineStyles ? DEFAULT_LIST_STYLE : void 0,
      "aria-label": ariaLabel,
      children: steps.map((item) => /* @__PURE__ */ jsxs(
        "li",
        {
          className: classNames?.item,
          style: useDefaultInlineStyles ? getDefaultItemStyle(item.state) : void 0,
          "data-step-state": item.state,
          "aria-current": item.state === "running" ? "step" : void 0,
          children: [
            /* @__PURE__ */ jsx2(
              "span",
              {
                className: classNames?.marker,
                style: useDefaultInlineStyles ? getDefaultMarkerStyle(item.state) : void 0,
                "aria-hidden": "true",
                children: item.state === "complete" ? /* @__PURE__ */ jsx2(
                  "svg",
                  {
                    width: 10,
                    height: 10,
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 3,
                    strokeLinecap: "round",
                    strokeLinejoin: "round",
                    className: classNames?.checkIcon,
                    "aria-hidden": "true",
                    children: /* @__PURE__ */ jsx2("polyline", { points: "20 6 9 17 4 12" })
                  }
                ) : item.state === "running" ? /* @__PURE__ */ jsx2(
                  "svg",
                  {
                    width: 12,
                    height: 12,
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 2.5,
                    strokeLinecap: "round",
                    strokeLinejoin: "round",
                    className: classNames?.spinnerIcon,
                    "aria-hidden": "true",
                    children: /* @__PURE__ */ jsx2("path", { d: "M21 12a9 9 0 1 1-6.219-8.56" })
                  }
                ) : /* @__PURE__ */ jsx2(
                  "span",
                  {
                    className: classNames?.pendingDot,
                    style: useDefaultInlineStyles ? {
                      width: "4.5px",
                      height: "4.5px",
                      borderRadius: "50%",
                      background: "rgba(93, 111, 140, 0.45)"
                    } : void 0
                  }
                )
              }
            ),
            /* @__PURE__ */ jsx2(
              "span",
              {
                className: classNames?.label,
                style: useDefaultInlineStyles ? { margin: 0 } : void 0,
                children: item.label
              }
            )
          ]
        },
        item.id
      ))
    }
  );
}
var DEFAULT_TURN_DELAYS = [500, 1150, 1850, 2600];
function useStepProgression(isActive, options) {
  const startPhase = options?.startPhase ?? 0;
  const completedPhase = options?.completedPhase ?? 5;
  const delays = options?.delaysMs ?? DEFAULT_TURN_DELAYS;
  const resetKey = options?.resetKey;
  const [phase, setPhase] = useState(() => isActive ? startPhase : completedPhase);
  useEffect2(() => {
    if (!isActive) {
      setPhase(completedPhase);
      return;
    }
    setPhase(startPhase);
    const timers = delays.map(
      (ms, idx) => setTimeout(() => {
        setPhase(startPhase + idx + 1);
      }, ms)
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [isActive, resetKey, startPhase, completedPhase, delays]);
  return phase;
}
function useAnchoredActivityBubble(showBubble) {
  const messages = useWorkspaceMessages();
  const latestMessage = messages.at(-1);
  const hasUnansweredInitialPrompt = useMemo2(
    () => hasUnansweredInitialUserPrompt(messages),
    [messages]
  );
  const anchorMessageId = useMemo2(
    () => resolveActivityAnchorMessageId(messages, showBubble),
    [messages, showBubble]
  );
  const isBubbleAtEnd = useMemo2(
    () => isAnchoredBubbleAtConversationEnd(messages, showBubble, anchorMessageId),
    [messages, showBubble, anchorMessageId]
  );
  const isLatestUser = latestMessage?.role === "user" && !isBubbleAtEnd;
  const shouldRenderAfterMessage = useCallback2(
    (messageId) => showBubble && anchorMessageId === messageId,
    [showBubble, anchorMessageId]
  );
  const shouldRenderStandalone = showBubble && !anchorMessageId;
  return {
    anchorMessageId,
    isBubbleAtEnd,
    isLatestUser,
    hasUnansweredInitialPrompt,
    shouldRenderAfterMessage,
    shouldRenderStandalone
  };
}
function useAssistantActivity(options) {
  const state = useInteractionState();
  const [turns, setTurns] = useState([]);
  const [unavailable, setUnavailable] = useState(false);
  const etagRef = useRef3(null);
  const currentWorkspaceIdRef = useRef3(state?.workspaceId);
  const fastPollMs = options?.fastPollMs ?? 2e3;
  const idlePollMs = options?.idlePollMs ?? 2e4;
  const buildActivityUrl = options?.activityUrl ?? ((wsId) => `/api/interaction/v1/workspaces/${wsId}/activity`);
  const buildCancelUrl = options?.cancelUrl ?? ((wsId, runId) => `/api/interaction/v1/workspaces/${wsId}/runs/${runId}/cancel`);
  if (currentWorkspaceIdRef.current !== state?.workspaceId) {
    currentWorkspaceIdRef.current = state?.workspaceId;
    etagRef.current = null;
  }
  useEffect2(() => {
    if (!state?.workspaceId) return;
    const controller = new AbortController();
    let active = false;
    let timer = null;
    let currentDelay = fastPollMs;
    const scheduleNext = (delay) => {
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      timer = setTimeout(() => {
        void refresh();
      }, delay);
    };
    const refresh = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (active) return;
      active = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        const headers = {};
        if (etagRef.current) headers["If-None-Match"] = etagRef.current;
        const response = await fetch(buildActivityUrl(state.workspaceId), {
          cache: "no-store",
          signal: controller.signal,
          headers
        });
        if (response.status === 304) {
          if (!controller.signal.aborted) {
            setUnavailable(false);
            scheduleNext(currentDelay);
          }
          return;
        }
        if (!response.ok) throw new Error("ACTIVITY_UNAVAILABLE");
        const etag = response.headers.get("ETag") || response.headers.get("etag");
        if (etag) etagRef.current = etag;
        const body = await response.json();
        if (!controller.signal.aborted) {
          const nextTurns = body.turns ?? [];
          setTurns(nextTurns);
          setUnavailable(false);
          const hasActiveRun = nextTurns.some(
            (t) => t.status === "pending" || t.status === "running" || t.status === "queued"
          );
          currentDelay = hasActiveRun ? fastPollMs : idlePollMs;
          scheduleNext(currentDelay);
        }
      } catch {
        if (!controller.signal.aborted) {
          setUnavailable(true);
          scheduleNext(currentDelay);
        }
      } finally {
        active = false;
      }
    };
    const onVisibilityChange = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "visible") {
        void refresh();
      } else if (document.visibilityState === "hidden" && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    void refresh();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [state?.workspaceId, state?.sequence, fastPollMs, idlePollMs]);
  const activeTurn = useMemo2(
    () => turns.find((t) => t.status === "running" || t.status === "queued") ?? null,
    [turns]
  );
  const hasActiveTurn = useMemo2(
    () => turns.some((t) => t.status === "pending" || t.status === "queued" || t.status === "running") || !!activeTurn,
    [turns, activeTurn]
  );
  const queuedCount = useMemo2(
    () => turns.filter((t) => t.status === "pending").length,
    [turns]
  );
  const cancelActiveTurn = useCallback2(
    async (reason = "Stopped by user") => {
      if (!state?.workspaceId || !activeTurn?.runId) return false;
      const response = await fetch(buildCancelUrl(state.workspaceId, activeTurn.runId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason })
      });
      if (!response.ok) {
        throw new Error("Could not stop assistant; retry.");
      }
      return true;
    },
    [state?.workspaceId, activeTurn?.runId]
  );
  return {
    turns,
    unavailable,
    activeTurn,
    hasActiveTurn,
    queuedCount,
    cancelActiveTurn
  };
}
export {
  InteractionContext,
  InteractionProvider,
  InteractionStepTrail,
  buildVariedSearchSteps,
  buildVariedSearchSummary,
  buildVariedSteps,
  buildVariedTurnSteps,
  createImplicitActionDetector,
  createStageSuggestions,
  formatShortTopic,
  hasUnansweredInitialUserPrompt,
  hashSeed,
  isAnchoredBubbleAtConversationEnd,
  pickDeterministic,
  pickStepCount,
  resolveActivityAnchorMessageId,
  resolveSplitCanvasLayout,
  useAnchoredActivityBubble,
  useAssistantActivity,
  useDispatchAction,
  useInteractionHistory,
  useInteractionSelector,
  useInteractionState,
  useInteractionStore,
  useIsCrossTabLeader,
  useRunAssistant,
  useSendMessage,
  useStepProgression,
  useWorkspaceConnection,
  useWorkspaceMessages,
  useWorkspacePending,
  useWorkspaceView
};
//# sourceMappingURL=index.js.map
