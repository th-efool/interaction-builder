import { describe, expect, it } from 'vitest';
import { applyJsonPatch, generateJsonPatch } from '../src/core/patch';
import { reduceInteraction, type InteractionClientState } from '../src/core/reducer';

describe('RFC 6902 JSON Patch Engine & Delta State Sync', () => {
  it('generates and applies patches on nested objects and arrays', () => {
    const prev = {
      title: 'Original Title',
      tags: ['alpha', 'beta'],
      author: { name: 'Alice', role: 'editor' },
    };

    const next = {
      title: 'Updated Title',
      tags: ['alpha', 'gamma', 'delta'],
      author: { name: 'Alice', role: 'admin' },
      published: true,
    };

    const patch = generateJsonPatch(prev, next);
    expect(patch.length).toBeGreaterThan(0);

    const applied = applyJsonPatch(prev, patch);
    expect(applied).toEqual(next);
  });

  it('handles item removal cleanly', () => {
    const prev = { a: 1, b: 2, c: 3 };
    const next = { a: 1, c: 3 };

    const patch = generateJsonPatch(prev, next);
    expect(patch).toEqual([{ op: 'remove', path: '/b' }]);

    const applied = applyJsonPatch(prev, patch);
    expect(applied).toEqual(next);
  });

  it('handles empty diffs when objects are identical', () => {
    const doc = { count: 42, active: true };
    const patch = generateJsonPatch(doc, { count: 42, active: true });
    expect(patch).toEqual([]);
  });

  it('applies delta patches directly in the client reducer', () => {
    const initial: InteractionClientState<{ count: number; note: string }> = {
      workspaceId: '550e8400-e29b-41d4-a716-446655440001',
      revision: 1,
      sequence: 1,
      view: { count: 10, note: 'initial' },
      messages: [],
      connection: 'live',
      pending: {},
    };

    const patch = generateJsonPatch(initial.view, { count: 11, note: 'updated' });

    const reduced = reduceInteraction(initial, {
      kind: 'server',
      event: {
        protocolVersion: 1,
        eventId: '550e8400-e29b-41d4-a716-446655440002',
        workspaceId: '550e8400-e29b-41d4-a716-446655440001',
        sequence: 2,
        type: 'workspace.committed',
        revision: 2,
        payload: {
          receipt: {},
          patch,
        },
      },
    });

    expect(reduced.sequence).toBe(2);
    expect(reduced.revision).toBe(2);
    expect(reduced.view).toEqual({ count: 11, note: 'updated' });
  });
});
