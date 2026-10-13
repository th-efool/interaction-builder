import { describe, expect, it } from 'vitest';
import { reduceInteraction, type InteractionClientState } from '../src/core/reducer';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const event = (sequence: number, type: 'run.changed' | 'workspace.committed' = 'run.changed', revision?: number) => ({
  protocolVersion: 1 as const,
  eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  workspaceId,
  sequence,
  type,
  revision,
  payload: {},
});
const state = (): InteractionClientState<{ value: string }> => ({
  workspaceId,
  revision: 0,
  sequence: 0,
  view: { value: 'old' },
  messages: [],
  connection: 'live',
  pending: {},
});

describe('interaction client reducer', () => {
  it('applies each event once and ignores duplicate sequence', () => {
    const first = reduceInteraction(state(), { kind: 'server', event: event(1) });
    expect(first.sequence).toBe(1);
    expect(reduceInteraction(first, { kind: 'server', event: event(1) }).sequence).toBe(1);
  });

  it('requires reset when event gap appears', () => {
    expect(reduceInteraction(state(), { kind: 'server', event: event(3) }).connection).toBe('reset_required');
  });

  it('rejects events from another workspace', () => {
    expect(
      reduceInteraction(state(), {
        kind: 'server',
        event: { ...event(1), workspaceId: '00000000-0000-4000-8000-000000000002' },
      }).sequence
    ).toBe(0);
  });

  it('updates revision only on committed event', () => {
    const result = reduceInteraction(state(), { kind: 'server', event: event(1, 'workspace.committed', 2) });
    expect(result.revision).toBe(2);
  });
});
