import { type InteractionMessage } from './contracts';
export interface InteractionClientState<View = unknown> {
    workspaceId: string;
    revision: number;
    sequence: number;
    view: View;
    messages: InteractionMessage[];
    connection: 'connecting' | 'live' | 'reconnecting' | 'reset_required';
    pending: Record<string, 'pending' | 'failed'>;
}
export type InteractionClientEvent<View = unknown> = {
    kind: 'snapshot';
    workspaceId: string;
    revision: number;
    sequence: number;
    view: View;
    messages: InteractionMessage[];
} | {
    kind: 'server';
    event: unknown;
} | {
    kind: 'request_pending';
    actionId: string;
} | {
    kind: 'request_failed';
    actionId: string;
} | {
    kind: 'connection';
    value: InteractionClientState['connection'];
};
export declare function reduceInteraction<View>(state: InteractionClientState<View>, input: InteractionClientEvent<View>): InteractionClientState<View>;
//# sourceMappingURL=reducer.d.ts.map