import { describe, expect, it } from 'vitest';
import { MemoryInteractionRepository } from '../src/runtime/memory.repository';
import { createInteractionHandlers } from '../src/runtime/handlers';
import { streamEvents } from '../src/runtime/sse';
import { agendaDomain, sampleAgenda } from '../src/testkit/agenda-domain';
import { interactionEventSchema } from '../src/core/contracts';
import { reduceInteraction, type InteractionClientState } from '../src/core/reducer';
import { parseSseStream } from '../src/client/transport';

const WS = '4f828a1c-3b09-42b7-8738-4e50257ad42f';

const act = (rev: number, title: string) => ({
  actionId: crypto.randomUUID(),
  workspaceId: WS,
  expectedRevision: rev,
  entityVersions: [],
  action: { type: 'set_meeting_title', title },
});

async function setup() {
  const h = createInteractionHandlers({
    repo: new MemoryInteractionRepository(),
    domains: new Map([[agendaDomain.id, agendaDomain]]),
  });
  await h.createWorkspace('u1', {
    workspaceId: WS,
    domainId: 'agenda',
    bootstrap: sampleAgenda,
  });
  await h.commitAction('u1', undefined, act(0, 'Title A'));
  await h.commitAction('u1', undefined, act(1, 'Title B'));
  return h;
}

const read = (r: Response) => r.text();

describe('SSE', () => {
  it('delivers repository messages and commits into the client before stream closure', async () => {
    const repo = new MemoryInteractionRepository();
    const h = createInteractionHandlers({ repo, domains: new Map([[agendaDomain.id, agendaDomain]]) });
    await h.createWorkspace('u1', { workspaceId: WS, domainId: 'agenda', bootstrap: sampleAgenda });
    await repo.appendMessage({ workspaceId: WS, ownerId: 'u1', id: crypto.randomUUID(), role: 'assistant', parts: [{ type: 'text', text: 'Ready to learn.' }] });
    await h.commitAction('u1', undefined, act(0, 'New title'));
    const json = await h.getEvents('u1', WS, 0);
    const events = (json.body as { events: unknown[] }).events;
    expect(events).toHaveLength(2);
    events.forEach(event => expect(interactionEventSchema.safeParse(event).success).toBe(true));

    let state: InteractionClientState = { workspaceId: WS, revision: 0, sequence: 0, view: sampleAgenda, messages: [], connection: 'live', pending: {} };
    let closed = false;
    const ac = new AbortController();
    const response = await streamEvents(h, 'u1', WS, 0, { signal: ac.signal, maxMs: 5000 });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Events did not reach the client while the stream was open')), 1000);
        parseSseStream(response.body!, event => {
          state = reduceInteraction(state, { kind: 'server', event });
          if (state.sequence === 2) { clearTimeout(deadline); resolve(); }
        }, () => { closed = true; });
      });
      expect(closed).toBe(false);
      expect(state.messages[0]?.parts).toEqual([{ type: 'text', text: 'Ready to learn.' }]);
      expect(state.revision).toBe(1);
    } finally { ac.abort(); }
  });

  it('replays events after cursor with persisted-sequence ids, then closes at maxMs', async () => {
    const h = await setup();
    const text = await read(
      await streamEvents(h, 'u1', WS, 1, { pollMs: 15, maxMs: 150, heartbeatMs: 10 })
    );
    expect(text).toContain('id: 2\nevent: workspace.committed');
    expect(text).not.toContain('id: 1\n');
    expect(text).toContain(': hb');
  });

  it('delivers live commits made during the stream', async () => {
    const h = await setup();
    const res = await streamEvents(h, 'u1', WS, 2, { pollMs: 5, maxMs: 120 });
    setTimeout(() => {
      void h.commitAction('u1', undefined, act(2, 'Title C'));
    }, 20);
    expect(await read(res)).toContain('id: 3\n');
  });

  it('foreign owner gets 404 JSON, not a stream', async () => {
    const h = await setup();
    const res = await streamEvents(h, 'u2', WS, 0);
    expect(res.status).toBe(404);
  });
});
