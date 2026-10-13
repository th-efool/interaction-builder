import { z } from 'zod';

export const entityRefSchema = z.strictObject({
  kind: z.string().min(1).max(80),
  id: z.string().min(1).max(200),
  version: z.number().int().nonnegative(),
});
export type EntityRef = z.infer<typeof entityRefSchema>;

export const changeReceiptSchema = z.strictObject({
  receiptId: z.string().uuid(),
  actionId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
  changed: z.array(entityRefSchema).max(100),
  undoable: z.boolean(),
});
export type ChangeReceipt = z.infer<typeof changeReceiptSchema>;

export const messagePartSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().max(32_000) }),
  z.strictObject({ type: z.literal('entity_ref'), entity: entityRefSchema, label: z.string().max(300) }),
  z.strictObject({ type: z.literal('activity'), status: z.enum(['queued', 'running', 'waiting', 'done', 'failed']), text: z.string().max(500) }),
  z.strictObject({ type: z.literal('change_receipt'), receipt: changeReceiptSchema }),
  z.strictObject({ type: z.literal('warning'), text: z.string().max(2_000) }),
]);
export type MessagePart = z.infer<typeof messagePartSchema>;

export const interactionMessageSchema = z.strictObject({
  id: z.string().uuid(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(messagePartSchema).min(1).max(100),
  sequence: z.number().int().positive(),
  runId: z.string().uuid().nullable(),
});
export type InteractionMessage = z.infer<typeof interactionMessageSchema>;

export const interactionEventSchema = z.strictObject({
  protocolVersion: z.literal(1),
  eventId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: z.enum([
    'message.accepted',
    'message.updated',
    'workspace.committed',
    'run.changed',
    'job.changed',
    'proposal.created',
    'proposal.resolved',
  ]),
  revision: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});
export type InteractionEvent = z.infer<typeof interactionEventSchema>;

export const actionEnvelopeSchema = z.strictObject({
  actionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  entityVersions: z.array(entityRefSchema).max(100),
  action: z.unknown(),
});
export type ActionEnvelope = z.infer<typeof actionEnvelopeSchema>;

export interface RuntimeSchema<T> {
  parse(input: unknown): T;
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export interface DomainActionPlan<State> {
  nextState: State;
  changed: EntityRef[];
  invalidated: string[];
  summary: string;
  undoable: boolean;
}
