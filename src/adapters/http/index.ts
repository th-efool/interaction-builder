import type { createInteractionHandlers, HandlerResult } from '../../runtime/handlers';
import { streamEvents } from '../../runtime/sse';

type Handlers = ReturnType<typeof createInteractionHandlers>;
const MAX_BODY = 256 * 1024;
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function json(r: HandlerResult): Response {
  return new Response(JSON.stringify(r.body), { status: r.status, headers: HEADERS });
}

const err = (status: number, code: string) =>
  json({ status, body: { code, message: code, retryable: false } });

/**
 * Explicit route table (no dynamic imports from URL). `segments` = path after /api/interaction/v1.
 *   POST workspaces | GET workspaces/:id | POST workspaces/:id/actions | GET workspaces/:id/events?after=N
 *   POST workspaces/:id/messages | POST workspaces/:id/run | GET workspaces/:id/runs/active
 *   POST workspaces/:id/runs/:runId/cancel | GET workspaces/:id/proposals | POST workspaces/:id/proposals/:id/decide
 */
export async function dispatchInteraction(
  request: Request,
  segments: string[],
  getOwner: () => Promise<string | null>,
  h: Handlers
): Promise<Response> {
  const owner = await getOwner();
  if (!owner) return err(401, 'UNAUTHORIZED');
  const [root, id, sub, subId, subAction] = segments;
  if (root !== 'workspaces') return err(404, 'NOT_FOUND');
  const method = request.method.toUpperCase();

  const readBody = async (): Promise<unknown | Response> => {
    const text = await request.text();
    if (text.length === 0) return {};
    if (text.length > MAX_BODY) return err(413, 'INVALID_ACTION');
    try {
      return JSON.parse(text);
    } catch {
      return err(400, 'INVALID_ACTION');
    }
  };

  if (!id && method === 'POST') {
    const body = await readBody();
    if (body instanceof Response) return body;
    return json(await h.createWorkspace(owner, body));
  }
  if (id && !sub && method === 'GET') return json(await h.getWorkspace(owner, id));
  if (id && sub === 'actions' && method === 'POST') {
    const body = await readBody();
    if (body instanceof Response) return body;
    // Path workspace id is authoritative; reject mismatching body.
    if ((body as { workspaceId?: string })?.workspaceId !== id) return err(400, 'INVALID_ACTION');
    return json(await h.commitAction(owner, request.headers.get('idempotency-key') ?? undefined, body));
  }
  if (id && sub === 'messages' && method === 'POST') {
    const body = await readBody();
    if (body instanceof Response) return body;
    return json(await h.sendMessage(owner, id, request.headers.get('idempotency-key') ?? undefined, body));
  }
  if (id && sub === 'run' && method === 'POST') {
    return json(await h.runAssistant(owner, id));
  }
  if (id && sub === 'runs' && subId === 'active' && method === 'GET') {
    return json(await h.getActiveRun(owner, id));
  }
  if (id && sub === 'runs' && subId && !subAction && method === 'GET') {
    return json(await h.getRun(owner, id, subId));
  }
  if (id && sub === 'runs' && subId && subAction === 'cancel' && method === 'POST') {
    const body = await readBody();
    if (body instanceof Response) return body;
    return json(await h.cancelRun(owner, id, subId, body));
  }
  if (id && sub === 'proposals' && !subId && method === 'GET') {
    const state = new URL(request.url).searchParams.get('state') ?? undefined;
    return json(await h.listProposals(owner, id, state));
  }
  if (id && sub === 'proposals' && subId && subAction === 'decide' && method === 'POST') {
    const body = await readBody();
    if (body instanceof Response) return body;
    return json(await h.decideProposal(owner, id, subId, body));
  }
  if (id && sub === 'messages' && method === 'GET') {
    const raw = new URL(request.url).searchParams.get('before');
    const before = raw === null ? undefined : Number(raw);
    return json(
      await h.listMessages(
        owner,
        id,
        before !== undefined && Number.isInteger(before) && before > 0 ? before : undefined
      )
    );
  }
  if (id && sub === 'events' && method === 'GET') {
    const sp = new URL(request.url).searchParams;
    const raw = Number(request.headers.get('last-event-id') ?? sp.get('after') ?? 0);
    const after = Number.isInteger(raw) && raw >= 0 ? raw : 0;
    if (request.headers.get('accept')?.includes('text/event-stream')) {
      return streamEvents(h, owner, id, after, { signal: request.signal });
    }
    return json(await h.getEvents(owner, id, after));
  }
  return err(405, 'NOT_FOUND');
}
