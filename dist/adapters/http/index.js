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
      signal?.addEventListener("abort", close);
      send("retry: 1000\n\n");
      let batch = first.body.events;
      try {
        while (!closed) {
          for (const e of batch) {
            send(frame(e));
            cursor = e.sequence;
          }
          if (Date.now() - started >= maxMs) break;
          if (Date.now() - lastBeat >= heartbeatMs) {
            send(": hb\n\n");
            lastBeat = Date.now();
          }
          await new Promise((r) => setTimeout(r, pollMs));
          if (closed) break;
          const next = await h.getEvents(ownerId, workspaceId, cursor);
          if (next.status !== 200) break;
          batch = next.body.events;
        }
      } finally {
        close();
      }
    },
    cancel() {
      closed = true;
    }
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

// src/adapters/http/index.ts
var MAX_BODY = 256 * 1024;
var HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
function json(r) {
  return new Response(JSON.stringify(r.body), { status: r.status, headers: HEADERS });
}
var err = (status, code) => json({ status, body: { code, message: code, retryable: false } });
async function dispatchInteraction(request, segments, getOwner, h) {
  const owner = await getOwner();
  if (!owner) return err(401, "UNAUTHORIZED");
  const [root, id, sub, subId, subAction] = segments;
  if (root !== "workspaces") return err(404, "NOT_FOUND");
  const method = request.method.toUpperCase();
  const readBody = async () => {
    const text = await request.text();
    if (text.length === 0) return {};
    if (text.length > MAX_BODY) return err(413, "INVALID_ACTION");
    try {
      return JSON.parse(text);
    } catch {
      return err(400, "INVALID_ACTION");
    }
  };
  if (!id && method === "POST") {
    const body = await readBody();
    if (body instanceof Response) return body;
    return json(await h.createWorkspace(owner, body));
  }
  if (id && !sub && method === "GET") return json(await h.getWorkspace(owner, id));
  if (id && sub === "actions" && method === "POST") {
    const body = await readBody();
    if (body instanceof Response) return body;
    if (body?.workspaceId !== id) return err(400, "INVALID_ACTION");
    return json(await h.commitAction(owner, request.headers.get("idempotency-key") ?? void 0, body));
  }
  if (id && sub === "messages" && method === "POST") {
    const body = await readBody();
    if (body instanceof Response) return body;
    return json(await h.sendMessage(owner, id, request.headers.get("idempotency-key") ?? void 0, body));
  }
  if (id && sub === "run" && method === "POST") {
    return json(await h.runAssistant(owner, id));
  }
  if (id && sub === "runs" && subId === "active" && method === "GET") {
    return json(await h.getActiveRun(owner, id));
  }
  if (id && sub === "runs" && subId && !subAction && method === "GET") {
    return json(await h.getRun(owner, id, subId));
  }
  if (id && sub === "runs" && subId && subAction === "cancel" && method === "POST") {
    const body = await readBody();
    if (body instanceof Response) return body;
    return json(await h.cancelRun(owner, id, subId, body));
  }
  if (id && sub === "proposals" && !subId && method === "GET") {
    const state = new URL(request.url).searchParams.get("state") ?? void 0;
    return json(await h.listProposals(owner, id, state));
  }
  if (id && sub === "proposals" && subId && subAction === "decide" && method === "POST") {
    const body = await readBody();
    if (body instanceof Response) return body;
    return json(await h.decideProposal(owner, id, subId, body));
  }
  if (id && sub === "messages" && method === "GET") {
    const raw = new URL(request.url).searchParams.get("before");
    const before = raw === null ? void 0 : Number(raw);
    return json(
      await h.listMessages(
        owner,
        id,
        before !== void 0 && Number.isInteger(before) && before > 0 ? before : void 0
      )
    );
  }
  if (id && sub === "events" && method === "GET") {
    const sp = new URL(request.url).searchParams;
    const raw = Number(request.headers.get("last-event-id") ?? sp.get("after") ?? 0);
    const after = Number.isInteger(raw) && raw >= 0 ? raw : 0;
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      return streamEvents(h, owner, id, after, { signal: request.signal });
    }
    return json(await h.getEvents(owner, id, after));
  }
  return err(405, "NOT_FOUND");
}
export {
  dispatchInteraction
};
//# sourceMappingURL=index.js.map
