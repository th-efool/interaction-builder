import { describe, expect, it } from 'vitest';
import { planBatchActionCommit } from '../src/runtime/action.service';

describe('Atomic Batch Action Execution', () => {
  it('executes a sequence of actions in a single atomic planner call', () => {
    let state = { count: 0, log: [] as string[] };

    const envelopes = [
      {
        actionId: '550e8400-e29b-41d4-a716-446655440010',
        workspaceId: '550e8400-e29b-41d4-a716-446655440001',
        expectedRevision: 0,
        entityVersions: [],
        action: { type: 'add', text: 'first' },
      },
      {
        actionId: '550e8400-e29b-41d4-a716-446655440011',
        workspaceId: '550e8400-e29b-41d4-a716-446655440001',
        expectedRevision: 1,
        entityVersions: [],
        action: { type: 'add', text: 'second' },
      },
    ];

    const plan = (s: typeof state, action: any) => ({
      nextState: { count: s.count + 1, log: [...s.log, action.text] },
      changed: [],
      invalidated: [],
      summary: `Add ${action.text}`,
      undoable: true,
    });

    const res = planBatchActionCommit({
      state,
      currentRevision: 0,
      envelopes,
      plan,
    });

    expect(res.state.count).toBe(2);
    expect(res.state.log).toEqual(['first', 'second']);
    expect(res.revision).toBe(2);
    expect(res.receipts.length).toBe(2);
    expect(res.receipts[0].actionId).toBe(envelopes[0].actionId);
    expect(res.receipts[1].actionId).toBe(envelopes[1].actionId);
  });

  it('rejects the entire batch if an intermediate action has a stale expected revision', () => {
    const state = { count: 0 };
    const envelopes = [
      {
        actionId: '550e8400-e29b-41d4-a716-446655440020',
        workspaceId: '550e8400-e29b-41d4-a716-446655440001',
        expectedRevision: 0,
        entityVersions: [],
        action: { type: 'inc' },
      },
      {
        actionId: '550e8400-e29b-41d4-a716-446655440021',
        workspaceId: '550e8400-e29b-41d4-a716-446655440001',
        expectedRevision: 0, // Stale! Should be 1 after the first action
        entityVersions: [],
        action: { type: 'inc' },
      },
    ];

    expect(() =>
      planBatchActionCommit({
        state,
        currentRevision: 0,
        envelopes,
        plan: s => ({
          nextState: { count: s.count + 1 },
          changed: [],
          invalidated: [],
          summary: 'inc',
          undoable: true,
        }),
      })
    ).toThrow('STALE_WORKSPACE');
  });
});
