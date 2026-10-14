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
function defineAction(type, schema) {
  return {
    type,
    schema,
    create(payload) {
      if (schema) {
        schema.parse(payload);
      }
      return { type, ...payload };
    }
  };
}

// src/core/patch.ts
function escapeJsonPointer(str) {
  return str.replace(/~/g, "~0").replace(/\//g, "~1");
}
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
function generateJsonPatch(prev, next, basePath = "") {
  const patch = [];
  if (prev === next) return patch;
  if (prev === null || next === null || typeof prev !== "object" || typeof next !== "object" || Array.isArray(prev) !== Array.isArray(next)) {
    patch.push({ op: "replace", path: basePath, value: next });
    return patch;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length === next.length) {
      for (let i = 0; i < prev.length; i++) {
        const itemPath = `${basePath}/${i}`;
        patch.push(...generateJsonPatch(prev[i], next[i], itemPath));
      }
    } else {
      patch.push({ op: "replace", path: basePath, value: next });
    }
    return patch;
  }
  const prevObj = prev;
  const nextObj = next;
  const prevKeys = Object.keys(prevObj);
  const nextKeys = Object.keys(nextObj);
  for (const k of prevKeys) {
    if (!(k in nextObj)) {
      patch.push({ op: "remove", path: `${basePath}/${escapeJsonPointer(k)}` });
    }
  }
  for (const k of nextKeys) {
    const keyPath = `${basePath}/${escapeJsonPointer(k)}`;
    if (!(k in prevObj)) {
      patch.push({ op: "add", path: keyPath, value: nextObj[k] });
    } else {
      patch.push(...generateJsonPatch(prevObj[k], nextObj[k], keyPath));
    }
  }
  return patch;
}
function getValueByPointer(doc, path) {
  if (path === "") return doc;
  const tokens = parsePointer(path);
  let current = doc;
  for (const token of tokens) {
    if (current === null || typeof current !== "object") return void 0;
    if (!(token in current)) return void 0;
    current = current[token];
  }
  return current;
}
function invertJsonPatch(doc, patch) {
  const inverted = [];
  for (let i = patch.length - 1; i >= 0; i--) {
    const op = patch[i];
    if (op.path === "") {
      inverted.push({ op: "replace", path: "", value: structuredClone(doc) });
      continue;
    }
    if (op.op === "add") {
      inverted.push({ op: "remove", path: op.path });
    } else if (op.op === "remove") {
      const prevVal = getValueByPointer(doc, op.path);
      inverted.push({ op: "add", path: op.path, value: structuredClone(prevVal) });
    } else if (op.op === "replace") {
      const prevVal = getValueByPointer(doc, op.path);
      inverted.push({ op: "replace", path: op.path, value: structuredClone(prevVal) });
    } else {
      throw new Error(`Unsupported JSON Patch operation for inversion: "${op.op}"`);
    }
  }
  return inverted;
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
export {
  actionEnvelopeSchema,
  applyJsonPatch,
  changeReceiptSchema,
  defineAction,
  entityRefSchema,
  generateJsonPatch,
  getValueByPointer,
  interactionEventSchema,
  interactionMessageSchema,
  invertJsonPatch,
  messagePartSchema,
  reduceInteraction
};
//# sourceMappingURL=index.js.map
