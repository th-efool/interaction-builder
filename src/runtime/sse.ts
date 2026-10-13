import type { createInteractionHandlers } from './handlers';

type Handlers = ReturnType<typeof createInteractionHandlers>;

export interface SseOptions {
  /** Poll cadence for new committed events. */
  pollMs?: number;
  /** Close after this long; client reconnects with Last-Event-ID (bounded streams). */
  maxMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store, no-transform',
  'x-accel-buffering': 'no',
  connection: 'keep-alive',
};

const frame = (e: { sequence: number; type: string }) => `id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/**
 * Replay-to-live SSE. Only durable committed events are sent (id = persisted sequence).
 * Heartbeats are comments and never advance the cursor. Ownership checked before the stream opens.
 */
export async function streamEvents(h: Handlers, ownerId: string, workspaceId: string, after: number, opts: SseOptions = {}): Promise<Response> {
  const first = await h.getEvents(ownerId, workspaceId, after);
  if (first.status !== 200) return new Response(JSON.stringify(first.body), { status: first.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

  const { pollMs = 1000, maxMs = 25_000, heartbeatMs = 10_000, signal } = opts;
  const enc = new TextEncoder();
  let cursor = after;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now();
      let lastBeat = started;
      const send = (s: string) => controller.enqueue(enc.encode(s));
      const close = () => { if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } };
      signal?.addEventListener('abort', close);
      send('retry: 1000\n\n');
      let batch = (first.body as { events: { sequence: number; type: string }[] }).events;
      try {
        while (!closed) {
          for (const e of batch) { send(frame(e)); cursor = e.sequence; }
          if (Date.now() - started >= maxMs) break;
          if (Date.now() - lastBeat >= heartbeatMs) { send(': hb\n\n'); lastBeat = Date.now(); }
          await new Promise(r => setTimeout(r, pollMs));
          if (closed) break;
          const next = await h.getEvents(ownerId, workspaceId, cursor);
          if (next.status !== 200) break;
          batch = (next.body as { events: { sequence: number; type: string }[] }).events;
        }
      } finally { close(); }
    },
    cancel() { closed = true; },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
