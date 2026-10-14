import { describe, expect, it } from 'vitest';
import { applyJsonPatch, generateJsonPatch, getValueByPointer, invertJsonPatch } from '../src/core/patch';
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

  it('correctly patches root arrays of differing lengths without nesting', () => {
    const prev = [1, 2];
    const next = [1, 2, 3];
    const patch = generateJsonPatch(prev, next);
    expect(patch).toEqual([{ op: 'replace', path: '', value: [1, 2, 3] }]);

    const applied = applyJsonPatch(prev, patch);
    expect(applied).toEqual([1, 2, 3]);
  });

  it('correctly replaces root primitive values and nulls', () => {
    const patch = generateJsonPatch('old-string', 'new-string');
    expect(patch).toEqual([{ op: 'replace', path: '', value: 'new-string' }]);
    expect(applyJsonPatch('old-string', patch)).toBe('new-string');

    const nullPatch = generateJsonPatch({ a: 1 }, null);
    expect(nullPatch).toEqual([{ op: 'replace', path: '', value: null }]);
    expect(applyJsonPatch({ a: 1 }, nullPatch)).toBe(null);
  });

  it('correctly resolves values using getValueByPointer', () => {
    const doc = {
      user: { name: 'Bob', settings: { theme: 'dark' } },
      items: ['zero', 'one', 'two'],
    };
    expect(getValueByPointer(doc, '')).toEqual(doc);
    expect(getValueByPointer(doc, '/user/name')).toBe('Bob');
    expect(getValueByPointer(doc, '/user/settings/theme')).toBe('dark');
    expect(getValueByPointer(doc, '/items/1')).toBe('one');
    expect(getValueByPointer(doc, '/items/99')).toBeUndefined();
    expect(getValueByPointer(doc, '/non/existent/path')).toBeUndefined();
  });

  it('computes exact inverse patches that restore original document states', () => {
    const initialDoc = {
      title: 'Original Title',
      count: 10,
      tags: ['alpha', 'beta'],
      nested: { a: 1, b: 2 },
    };

    const targetDoc = {
      title: 'Modified Title',
      count: 25,
      tags: ['alpha', 'gamma'],
      nested: { a: 1, c: 3 },
    };

    const forwardPatch = generateJsonPatch(initialDoc, targetDoc);
    const modifiedDoc = applyJsonPatch(initialDoc, forwardPatch);
    expect(modifiedDoc).toEqual(targetDoc);

    const inversePatch = invertJsonPatch(initialDoc, forwardPatch);
    const restoredDoc = applyJsonPatch(modifiedDoc, inversePatch);
    expect(restoredDoc).toEqual(initialDoc);
  });
});

