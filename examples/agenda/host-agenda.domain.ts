import { z } from 'zod';
import { entityRefSchema, type DomainActionPlan, type EntityRef } from 'interaction-builder/core';
import type { DomainDefinition } from 'interaction-builder/runtime';

/**
 * Authoritative host-owned business entities.
 * Stored in the host application database (e.g. host_agenda_meetings & host_agenda_items).
 */
export const hostAgendaItemSchema = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  title: z.string().min(1).max(200),
  durationMinutes: z.number().int().min(1).max(240),
  presenter: z.string().min(1).max(100),
  pinned: z.boolean(),
  sortOrder: z.number().int().nonnegative(),
});
export type HostAgendaItem = z.infer<typeof hostAgendaItemSchema>;

export const hostAgendaMeetingSchema = z.strictObject({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  version: z.number().int().nonnegative(),
  meetingTitle: z.string().min(1).max(200),
  date: z.string(),
  items: z.array(hostAgendaItemSchema).max(50),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HostAgendaMeeting = z.infer<typeof hostAgendaMeetingSchema>;

/**
 * Typed host commands executed at the authorized host command boundary.
 */
export const hostAgendaCommandSchema = z.discriminatedUnion('type', [
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
export type HostAgendaCommand = z.infer<typeof hostAgendaCommandSchema>;

/**
 * Interaction Builder Workspace State for the Host-Owned Profile.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINT:
 * This state contains ONLY interaction context (the reference pointer to the host meeting,
 * the last observed version, and the active selection).
 *
 * IT MUST NOT STORE A DUPLICATE OF THE MEETING TITLE OR ITEMS ARRAY.
 * There is zero dual-writing: business mutations occur only in the host repository.
 */
export const hostBoundAgendaWorkspaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  meetingId: z.string().min(1),
  observedVersion: z.number().int().nonnegative(),
  selectedItemId: z.string().nullable().optional(),
});
export type HostBoundAgendaWorkspace = z.infer<typeof hostBoundAgendaWorkspaceSchema>;

export const hostBoundAgendaActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('select_item'),
    itemId: z.string().nullable(),
  }),
  z.strictObject({
    type: z.literal('sync_observed_version'),
    version: z.number().int().nonnegative(),
  }),
]);
export type HostBoundAgendaAction = z.infer<typeof hostBoundAgendaActionSchema>;

export interface HostBoundActionContext {
  actionId: string;
  workspaceId: string;
  expectedRevision: number;
  currentRevision: number;
  entityVersions: ReadonlyMap<string, number>;
}

export function planHostBoundAgendaAction(
  state: HostBoundAgendaWorkspace,
  actionInput: unknown,
  context: HostBoundActionContext
): DomainActionPlan<HostBoundAgendaWorkspace> {
  const action = hostBoundAgendaActionSchema.parse(actionInput);
  if (context.expectedRevision !== context.currentRevision) {
    throw new Error('STALE_WORKSPACE');
  }

  const next = structuredClone(state);
  const changed: EntityRef[] = [];

  if (action.type === 'select_item') {
    next.selectedItemId = action.itemId;
    return {
      nextState: next,
      changed: [],
      invalidated: ['selection'],
      summary: action.itemId ? `Selected item "${action.itemId}".` : 'Cleared item selection.',
      undoable: true,
    };
  }

  if (action.type === 'sync_observed_version') {
    next.observedVersion = action.version;
    changed.push(entityRefSchema.parse({
      kind: 'host_agenda_meeting',
      id: next.meetingId,
      version: action.version,
    }));
    return {
      nextState: next,
      changed,
      invalidated: ['resource_version'],
      summary: `Synced observed host resource version to ${action.version}.`,
      undoable: false,
    };
  }

  throw new Error('UNSUPPORTED_ACTION');
}

export const hostBoundAgendaDomain: DomainDefinition<HostBoundAgendaWorkspace> = {
  id: 'host_agenda',
  version: 1,
  initialState: (b: unknown) => hostBoundAgendaWorkspaceSchema.parse(b),
  plan: planHostBoundAgendaAction,
};
