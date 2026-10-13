import { interactionEventSchema, type InteractionEvent, type InteractionMessage } from './contracts';

export interface InteractionClientState<View = unknown> {
  workspaceId: string;
  revision: number;
  sequence: number;
  view: View;
  messages: InteractionMessage[];
  connection: 'connecting' | 'live' | 'reconnecting' | 'reset_required';
  pending: Record<string, 'pending' | 'failed'>;
}

export type InteractionClientEvent<View = unknown> =
  | { kind: 'snapshot'; workspaceId: string; revision: number; sequence: number; view: View; messages: InteractionMessage[] }
  | { kind: 'server'; event: unknown }
  | { kind: 'request_pending'; actionId: string }
  | { kind: 'request_failed'; actionId: string }
  | { kind: 'connection'; value: InteractionClientState['connection'] };

export function reduceInteraction<View>(
  state: InteractionClientState<View>,
  input: InteractionClientEvent<View>
): InteractionClientState<View> {
  if (input.kind === 'snapshot') {
    if (input.workspaceId !== state.workspaceId) return state;
    return {
      ...state,
      revision: input.revision,
      sequence: input.sequence,
      view: input.view,
      messages: input.messages,
      connection: 'live',
    };
  }
  if (input.kind === 'request_pending') {
    return { ...state, pending: { ...state.pending, [input.actionId]: 'pending' } };
  }
  if (input.kind === 'request_failed') {
    const pending = { ...state.pending, [input.actionId]: 'failed' as const };
    return { ...state, pending };
  }
  if (input.kind === 'connection') {
    return { ...state, connection: input.value };
  }

  const parsed = interactionEventSchema.safeParse(input.event);
  if (!parsed.success || parsed.data.workspaceId !== state.workspaceId) return state;
  const event: InteractionEvent = parsed.data;
  if (event.sequence <= state.sequence) return state;
  if (event.sequence !== state.sequence + 1) {
    return { ...state, connection: 'reset_required' };
  }
  if (event.type === 'message.accepted' && (event.payload as { message?: InteractionMessage })?.message) {
    const msg = (event.payload as { message: InteractionMessage }).message;
    const messages = state.messages.some(m => m.id === msg.id) ? state.messages : [...state.messages, msg];
    return { ...state, sequence: event.sequence, messages };
  }
  if (event.type === 'workspace.committed' && event.revision !== undefined) {
    return { ...state, sequence: event.sequence, revision: event.revision };
  }
  return { ...state, sequence: event.sequence };
}
