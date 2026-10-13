import { describe, expect, it } from 'vitest';
import { createHttpTransport, parseSseStream } from '../src/client/transport';
import { TransportError } from '../src/client/store';

describe('HTTP & SSE Transport', () => {
  it('parses SSE frames across fragmented chunks and ignores comments', async () => {
    const received: unknown[] = [];
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(': heartbeat\nid: 1\nevent: workspace.com'));
        controller.enqueue(enc.encode('mitted\ndata: {"sequence":1,"type":"workspace.committed"}\n\n'));
        controller.enqueue(enc.encode('id: 2\ndata: {"sequence":2,"type":"message.accepted"}\n\n'));
        controller.close();
      },
    });

    parseSseStream(
      stream,
      ev => received.push(ev),
      () => {
        closed = true;
      }
    );

    await new Promise(r => setTimeout(r, 50));

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ sequence: 1, type: 'workspace.committed' });
    expect(received[1]).toEqual({ sequence: 2, type: 'message.accepted' });
    expect(closed).toBe(true);
  });

  it('makes getWorkspace call and maps errors to TransportError', async () => {
    const fakeFetch = async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('/workspaces/ws-ok')) {
        return new Response(
          JSON.stringify({
            workspaceId: 'ws-ok',
            revision: 2,
            cursor: 5,
            snapshot: { title: 'Hello' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ code: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    const transportOk = createHttpTransport({
      baseUrl: '/api/interaction/v1',
      workspaceId: 'ws-ok',
      fetch: fakeFetch as typeof fetch,
    });
    const snap = await transportOk.getWorkspace();
    expect(snap.workspaceId).toBe('ws-ok');
    expect(snap.revision).toBe(2);

    const transportNotFound = createHttpTransport({
      baseUrl: '/api/interaction/v1',
      workspaceId: 'ws-missing',
      fetch: fakeFetch as typeof fetch,
    });
    await expect(transportNotFound.getWorkspace()).rejects.toThrow(TransportError);
  });

  it('sends commit and message with idempotency headers', async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: string | undefined;

    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      capturedBody = String(init?.body);
      return new Response(
        JSON.stringify({
          revision: 1,
          cursor: 1,
          snapshot: { title: 'Updated' },
          receipt: { receiptId: 'rec-1', summary: 'ok' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const transport = createHttpTransport({
      baseUrl: '/api/interaction/v1',
      workspaceId: 'ws-1',
      fetch: fakeFetch as typeof fetch,
    });

    const res = await transport.commit({ actionId: 'act-1' }, 'idemp-key-123');
    expect(res.revision).toBe(1);
    expect(capturedHeaders?.get('idempotency-key')).toBe('idemp-key-123');
    expect(capturedBody).toContain('act-1');

    await transport.sendMessage!({ id: 'msg-1', parts: [{ type: 'text', text: 'hi' }] }, 'idemp-key-456');
    expect(capturedHeaders?.get('idempotency-key')).toBe('idemp-key-456');
    expect(capturedBody).toContain('msg-1');
  });
});
