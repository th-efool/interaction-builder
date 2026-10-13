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
  const cacheRef = useRef2({
    initialized: false,
    value: void 0
  });
  const getSnapshot = useCallback(() => {
    const nextValue = selector(store.getState().view);
    if (cacheRef.current.initialized && cacheRef.current.value !== void 0 && isEqual(cacheRef.current.value, nextValue)) {
      return cacheRef.current.value;
    }
    cacheRef.current = { initialized: true, value: nextValue };
    return nextValue;
  }, [store, selector, isEqual]);
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
export {
  InteractionContext,
  InteractionProvider,
  useDispatchAction,
  useInteractionSelector,
  useInteractionState,
  useInteractionStore,
  useRunAssistant,
  useSendMessage,
  useWorkspaceConnection,
  useWorkspaceMessages,
  useWorkspacePending,
  useWorkspaceView
};
//# sourceMappingURL=index.js.map
