import { z } from 'zod';
import { entityRefSchema, type DomainActionPlan, type EntityRef } from '../core/contracts';
import type { DomainDefinition } from '../runtime/handlers';

export const agendaItemSchema = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  title: z.string().min(1).max(200),
  durationMinutes: z.number().int().min(1).max(240),
  presenter: z.string().min(1).max(100),
  pinned: z.boolean(),
});
export type AgendaItem = z.infer<typeof agendaItemSchema>;

export const agendaWorkspaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  meetingTitle: z.string().min(1).max(200),
  date: z.string(),
  items: z.array(agendaItemSchema).max(50),
});
export type AgendaWorkspace = z.infer<typeof agendaWorkspaceSchema>;

export const agendaActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('set_meeting_title'),
    title: z.string().min(1).max(200),
  }),
  z.strictObject({
    type: z.literal('edit_item'),
    itemId: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    durationMinutes: z.number().int().min(1).max(240).optional(),
  }),
  z.strictObject({
    type: z.literal('set_item_pin'),
    itemId: z.string().min(1),
    pinned: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('reorder_items'),
    itemIds: z.array(z.string()).min(1).max(50),
  }),
]);
export type AgendaAction = z.infer<typeof agendaActionSchema>;

export interface AgendaActionContext {
  actionId: string;
  workspaceId: string;
  expectedRevision: number;
  currentRevision: number;
  entityVersions: ReadonlyMap<string, number>;
}

export function planAgendaAction(
  state: AgendaWorkspace,
  actionInput: unknown,
  context: AgendaActionContext
): DomainActionPlan<AgendaWorkspace> {
  const action = agendaActionSchema.parse(actionInput);
  if (context.expectedRevision !== context.currentRevision) {
    throw new Error('STALE_WORKSPACE');
  }

  const next = structuredClone(state);
  const changed: EntityRef[] = [];
  const invalidated: string[] = [];

  const touch = (item: AgendaItem) => {
    item.version += 1;
    changed.push(entityRefSchema.parse({ kind: 'agenda_item', id: item.id, version: item.version }));
  };

  if (action.type === 'set_meeting_title') {
    next.meetingTitle = action.title;
    invalidated.push('overview');
    return {
      nextState: next,
      changed: [],
      invalidated,
      summary: `Meeting title updated to "${action.title}".`,
      undoable: true,
    };
  }

  const item = action.type === 'reorder_items' ? null : next.items.find(i => i.id === action.itemId);
  if (action.type !== 'reorder_items' && !item) {
    throw new Error('UNKNOWN_AGENDA_ITEM');
  }

  if (item) {
    const expected = context.entityVersions.get(item.id);
    if (expected !== undefined && expected !== item.version) {
      throw new Error('STALE_ENTITY');
    }
  }

  if (action.type === 'edit_item' && item) {
    if (action.title !== undefined && item.pinned) {
      throw new Error('PINNED_ITEM_PROTECTED');
    }
    if (action.title !== undefined) item.title = action.title;
    if (action.durationMinutes !== undefined) item.durationMinutes = action.durationMinutes;
    touch(item);
    return {
      nextState: next,
      changed,
      invalidated: ['timing'],
      summary: `Agenda item "${item.id}" updated.`,
      undoable: true,
    };
  }

  if (action.type === 'set_item_pin' && item) {
    item.pinned = action.pinned;
    touch(item);
    return {
      nextState: next,
      changed,
      invalidated: [],
      summary: action.pinned ? `Item "${item.id}" pinned.` : `Item "${item.id}" unpinned.`,
      undoable: true,
    };
  }

  if (action.type === 'reorder_items') {
    const currentIds = new Set(next.items.map(i => i.id));
    if (
      action.itemIds.length !== next.items.length ||
      action.itemIds.some(id => !currentIds.has(id)) ||
      new Set(action.itemIds).size !== action.itemIds.length
    ) {
      throw new Error('INVALID_AGENDA_ORDER');
    }
    const byId = new Map(next.items.map(i => [i.id, i]));
    next.items = action.itemIds.map(id => byId.get(id)!);
    next.items.forEach(touch);
    invalidated.push('timing');
    return {
      nextState: next,
      changed,
      invalidated,
      summary: 'Agenda items reordered.',
      undoable: true,
    };
  }

  throw new Error('UNSUPPORTED_ACTION');
}

export const sampleAgenda: AgendaWorkspace = {
  schemaVersion: 1,
  meetingTitle: 'Engineering Sync',
  date: '2026-10-14',
  items: [
    {
      id: 'item-1',
      version: 0,
      title: 'Architecture Review',
      durationMinutes: 15,
      presenter: 'Alice',
      pinned: false,
    },
    {
      id: 'item-2',
      version: 0,
      title: 'Roadmap Planning',
      durationMinutes: 20,
      presenter: 'Bob',
      pinned: true,
    },
  ],
};

export const agendaDomain: DomainDefinition<AgendaWorkspace> = {
  id: 'agenda',
  version: 1,
  initialState: b => agendaWorkspaceSchema.parse(b),
  plan: planAgendaAction,
};

