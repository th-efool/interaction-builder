import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAction } from '../src/core/contracts';
import { planActionCommit } from '../src/runtime/action.service';
import { createCompositeTelemetry, type InteractionTelemetryPort } from '../src/runtime/telemetry';

describe('Developer Experience & Telemetry', () => {
  it('defineAction creates typed action payloads and validates against schema', () => {
    const itemSchema = z.strictObject({
      itemId: z.string(),
      duration: z.number().int().positive(),
    });

    const updateItemAction = defineAction('UPDATE_ITEM', itemSchema);
    expect(updateItemAction.type).toBe('UPDATE_ITEM');

    const validPayload = updateItemAction.create({
      itemId: 'item-42',
      duration: 30,
    });
    expect(validPayload).toEqual({
      type: 'UPDATE_ITEM',
      itemId: 'item-42',
      duration: 30,
    });

    // Fails on invalid payload schema
    expect(() => {
      updateItemAction.create({
        itemId: 'item-42',
        duration: -5,
      });
    }).toThrow();
  });

  it('records action start and end events via telemetry port', () => {
    const events: any[] = [];
    const port1: InteractionTelemetryPort = {
      onActionStart: e => events.push({ port: 1, kind: 'start', ...e }),
      onActionEnd: e => events.push({ port: 1, kind: 'end', ...e }),
    };
    const port2: InteractionTelemetryPort = {
      onActionStart: e => events.push({ port: 2, kind: 'start', ...e }),
      onActionEnd: e => events.push({ port: 2, kind: 'end', ...e }),
    };

    const composite = createCompositeTelemetry([port1, port2]);

    const res = planActionCommit({
      state: { count: 0 },
      currentRevision: 0,
      envelope: {
        actionId: '550e8400-e29b-41d4-a716-446655440010',
        workspaceId: '550e8400-e29b-41d4-a716-446655440020',
        expectedRevision: 0,
        entityVersions: [],
        action: { type: 'INCREMENT' },
      },
      plan: state => ({
        nextState: { count: state.count + 1 },
        changed: [],
        invalidated: [],
        summary: 'Incremented counter',
        undoable: true,
      }),
      telemetry: composite,
    });

    expect(res.revision).toBe(1);
    expect(res.state.count).toBe(1);

    // Verify both telemetry ports recorded start and end
    expect(events.filter(e => e.kind === 'start').length).toBe(2);
    expect(events.filter(e => e.kind === 'end').length).toBe(2);
    const endEvent = events.find(e => e.kind === 'end');
    expect(endEvent.success).toBe(true);
    expect(endEvent.actionType).toBe('INCREMENT');
    expect(endEvent.durationMs).toBeGreaterThanOrEqual(0);
  });
});
