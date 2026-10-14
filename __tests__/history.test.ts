import { describe, expect, it } from 'vitest';
import { createInteractionStore } from '../src/client/store';

describe('Time-Travel & Undo/Redo Engine', () => {
  it('records history on commits and supports undo and redo', async () => {
    let currentRevision = 0;
    const store = createInteractionStore({
      workspaceId: '550e8400-e29b-41d4-a716-446655440001',
      initialView: { count: 0 },
      enableHistory: true,
      maxHistory: 10,
      transport: {
        getWorkspace: async () => ({
          workspaceId: '550e8400-e29b-41d4-a716-446655440001',
          revision: currentRevision,
          cursor: currentRevision,
          snapshot: { count: currentRevision },
          messages: [],
        }),
        commit: async (env: any) => {
          currentRevision += 1;
          return {
            revision: currentRevision,
            cursor: currentRevision,
            snapshot: { count: currentRevision * 10 },
            receipt: { receiptId: 'r-' + currentRevision, summary: 'Incremented to ' + (currentRevision * 10) },
          };
        },
        openEvents: () => () => {},
      },
    });

    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);

    // Commit 1
    await store.dispatchAction({ type: 'inc' });
    expect(store.getState().view.count).toBe(10);
    expect(store.canUndo()).toBe(true);
    expect(store.canRedo()).toBe(false);

    // Commit 2
    await store.dispatchAction({ type: 'inc' });
    expect(store.getState().view.count).toBe(20);
    expect(store.canUndo()).toBe(true);

    // Undo -> rolls back to commit 1 view (10)
    const undid1 = store.undo();
    expect(undid1).toBe(true);
    expect(store.getState().view.count).toBe(10);
    expect(store.canRedo()).toBe(true);

    // Undo -> rolls back to initial view (0)
    const undid2 = store.undo();
    expect(undid2).toBe(true);
    expect(store.getState().view.count).toBe(0);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);

    // Redo -> forward to 10
    const redid1 = store.redo();
    expect(redid1).toBe(true);
    expect(store.getState().view.count).toBe(10);
    expect(store.canUndo()).toBe(true);

    // Redo -> forward to 20
    const redid2 = store.redo();
    expect(redid2).toBe(true);
    expect(store.getState().view.count).toBe(20);
    expect(store.canRedo()).toBe(false);
  });

  it('supports direct time travel navigation by revision and reset', async () => {
    let currentRevision = 0;
    const store = createInteractionStore({
      workspaceId: '550e8400-e29b-41d4-a716-446655440001',
      initialView: { step: 'zero' },
      enableHistory: true,
      transport: {
        getWorkspace: async () => ({
          workspaceId: '550e8400-e29b-41d4-a716-446655440001',
          revision: currentRevision,
          cursor: currentRevision,
          snapshot: { step: 'zero' },
          messages: [],
        }),
        commit: async (env: any) => {
          currentRevision += 1;
          const step = currentRevision === 1 ? 'one' : 'two';
          return {
            revision: currentRevision,
            cursor: currentRevision,
            snapshot: { step },
            receipt: { receiptId: 'r-' + currentRevision, summary: 'Step ' + step },
          };
        },
        openEvents: () => () => {},
      },
    });

    await store.dispatchAction({ type: 'advance' }); // rev 1 ('one')
    await store.dispatchAction({ type: 'advance' }); // rev 2 ('two')

    expect(store.getState().view.step).toBe('two');

    // Time travel to revision 0 ('zero')
    const traveled = store.timeTravel(0);
    expect(traveled).toBe(true);
    expect(store.getState().view.step).toBe('zero');
    expect(store.getHistory().isTimeTraveling).toBe(true);

    // Reset time travel returns to latest live revision ('two')
    store.resetTimeTravel();
    expect(store.getState().view.step).toBe('two');
    expect(store.getHistory().isTimeTraveling).toBe(false);
  });
});
