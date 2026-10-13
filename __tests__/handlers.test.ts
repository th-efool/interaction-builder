import { describe, expect, it } from 'vitest';
import { MemoryInteractionRepository } from '../src/runtime/memory.repository';
import { createInteractionHandlers } from '../src/runtime/handlers';
import { agendaDomain, sampleAgenda, type AgendaWorkspace } from '../src/testkit/agenda-domain';

const WS = '4f828a1c-3b09-42b7-8738-4e50257ad42f';
const mk = () =>
  createInteractionHandlers({
    repo: new MemoryInteractionRepository(),
    domains: new Map([[agendaDomain.id, agendaDomain]]),
  });

const env = (rev: number, action: unknown) => ({
  actionId: crypto.randomUUID(),
  workspaceId: WS,
  expectedRevision: rev,
  entityVersions: [],
  action,
});

describe('interaction handlers', () => {
  it('create → get → action → events, owner isolated', async () => {
    const h = mk();
    expect(
      (
        await h.createWorkspace('u1', {
          workspaceId: WS,
          domainId: 'agenda',
          bootstrap: sampleAgenda,
        })
      ).status
    ).toBe(201);

    expect((await h.getWorkspace('u2', WS)).status).toBe(404);

    const r = await h.commitAction(
      'u1',
      'r1',
      env(0, { type: 'set_meeting_title', title: 'New Title' })
    );
    expect(r.status).toBe(200);
    expect((r.body as any).revision).toBe(1);

    const ev = await h.getEvents('u1', WS, 0);
    expect((ev.body as any).events).toHaveLength(1);
  });
});
