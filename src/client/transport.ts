import {
  type CommitResponse,
  type InteractionTransport,
  TransportError,
  type WorkspaceSnapshot,
} from './store';

export interface HttpTransportOptions {
  baseUrl?: string;
  workspaceId: string;
  fetch?: typeof globalThis.fetch;
}

export function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: unknown) => void,
  onClose: () => void
): void {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventType = '';
  let eventData = '';

  function processBuffer() {
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      let line = buffer.slice(0, newlineIndex);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      buffer = buffer.slice(newlineIndex + 1);

      if (line === '') {
        // Double newline - dispatch accumulated event
        if (eventData.length > 0) {
          try {
            const parsed = JSON.parse(eventData);
            onEvent(parsed);
          } catch {
            // Ignore malformed payloads
          }
          eventData = '';
          eventType = '';
        }
      } else if (line.startsWith(':')) {
        // Comment / heartbeat - ignore
      } else if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        const chunk = line.slice(6);
        eventData = eventData.length > 0 ? eventData + '\n' + chunk : chunk;
      }

      newlineIndex = buffer.indexOf('\n');
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
      // Reader canceled or network abort
    } finally {
      onClose();
    }
  })();
}

export function createHttpTransport<View>(opts: HttpTransportOptions): InteractionTransport<View> {
  const baseUrl = (opts.baseUrl ?? '/api/interaction/v1').replace(/\/+$/, '');
  const workspaceId = opts.workspaceId;
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    async getWorkspace(): Promise<WorkspaceSnapshot<View>> {
      const res = await doFetch(`${baseUrl}/workspaces/${workspaceId}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });

      if (!res.ok) {
        let code = 'NETWORK_ERROR';
        try {
          const body = (await res.json()) as { code?: string };
          if (body?.code) code = body.code;
        } catch {
          // ignore
        }
        throw new TransportError(res.status, code);
      }

      const body = (await res.json()) as WorkspaceSnapshot<View>;
      return body;
    },

    async commit(envelope: unknown, idempotencyKey: string): Promise<CommitResponse<View>> {
      const res = await doFetch(`${baseUrl}/workspaces/${workspaceId}/actions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(envelope),
      });

      if (!res.ok) {
        let code = 'INVALID_ACTION';
        try {
          const body = (await res.json()) as { code?: string };
          if (body?.code) code = body.code;
        } catch {
          // ignore
        }
        throw new TransportError(res.status, code);
      }

      const body = (await res.json()) as CommitResponse<View>;
      return body;
    },

    async sendMessage(message: { id: string; parts: unknown[] }, idempotencyKey: string) {
      const res = await doFetch(`${baseUrl}/workspaces/${workspaceId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(message),
      });

      if (!res.ok) {
        let code = 'INVALID_ACTION';
        try {
          const body = (await res.json()) as { code?: string };
          if (body?.code) code = body.code;
        } catch {
          // ignore
        }
        throw new TransportError(res.status, code);
      }

      const body = (await res.json()) as { message: unknown; cursor: number };
      return body;
    },

    async runAssistant() {
      const res = await doFetch(`${baseUrl}/workspaces/${workspaceId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });

      if (!res.ok) {
        let code = 'NETWORK_ERROR';
        try {
          const body = (await res.json()) as { code?: string };
          if (body?.code) code = body.code;
        } catch {
          // ignore
        }
        throw new TransportError(res.status, code);
      }

      const body = (await res.json()) as { success: boolean; text?: string };
      return body;
    },

    openEvents(cursor: number, onEvent: (event: unknown) => void, onClose: () => void): () => void {
      const controller = new AbortController();

      void (async () => {
        try {
          const res = await doFetch(`${baseUrl}/workspaces/${workspaceId}/events?after=${cursor}`, {
            method: 'GET',
            headers: {
              accept: 'text/event-stream',
              'last-event-id': String(cursor),
            },
            signal: controller.signal,
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
    },
  };
}
