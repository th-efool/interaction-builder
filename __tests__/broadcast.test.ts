import { describe, expect, it } from 'vitest';
import { createCrossTabCoordinator } from '../src/client/broadcast';
import { createInteractionStore } from '../src/client/store';

describe('Cross-Tab Synchronization & Leader Election', () => {
  it('elects a leader and broadcasts events to followers', async () => {
    const wsId = '550e8400-e29b-41d4-a716-446655440099';

    const tabA = createCrossTabCoordinator({
      workspaceId: wsId,
      tabId: 'tab-a',
      heartbeatIntervalMs: 50,
      leaderTimeoutMs: 200,
    });

    const tabB = createCrossTabCoordinator({
      workspaceId: wsId,
      tabId: 'tab-b',
      heartbeatIntervalMs: 50,
      leaderTimeoutMs: 200,
    });

    // Allow brief window for leader election
    await new Promise(r => setTimeout(r, 350));

    // One of them must be the elected leader
    const aIsLeader = tabA.isLeader();
    const bIsLeader = tabB.isLeader();
    expect(aIsLeader || bIsLeader).toBe(true);

    const leader = aIsLeader ? tabA : tabB;
    const follower = aIsLeader ? tabB : tabA;

    // Broadcast an event from leader to follower
    const received: any[] = [];
    follower.onEvent(ev => received.push(ev));

    leader.broadcastEvent({ type: 'workspace.committed', sequence: 42 });

    await new Promise(r => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'workspace.committed', sequence: 42 });

    tabA.destroy();
    tabB.destroy();
  });

  it('runs InteractionStore with crossTabSync enabled without errors', async () => {
    const store = createInteractionStore({
      workspaceId: '550e8400-e29b-41d4-a716-446655440098',
      initialView: { title: 'Cross Tab' },
      crossTabSync: true,
      transport: {
        getWorkspace: async () => ({
          workspaceId: '550e8400-e29b-41d4-a716-446655440098',
          revision: 0,
          cursor: 0,
          snapshot: { title: 'Cross Tab' },
          messages: [],
        }),
        commit: async () => ({} as any),
        openEvents: () => () => {},
      },
    });

    await store.connect();
    expect(store.getState().view.title).toBe('Cross Tab');
    store.disconnect();
  });
});
