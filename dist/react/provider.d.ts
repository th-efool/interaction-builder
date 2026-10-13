import React from 'react';
import { type InteractionStore, type InteractionTransport } from '../client/store';
export interface InteractionProviderProps<View> {
    workspaceId: string;
    initialView: View;
    transport?: InteractionTransport<View>;
    children: React.ReactNode;
}
export declare const InteractionContext: React.Context<InteractionStore<any> | null>;
export declare function InteractionProvider<View>({ workspaceId, initialView, transport, children, }: InteractionProviderProps<View>): React.JSX.Element;
export declare function useInteractionStore<View = unknown>(): InteractionStore<View>;
//# sourceMappingURL=provider.d.ts.map