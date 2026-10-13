import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import {
  createInteractionStore,
  type InteractionStore,
  type InteractionTransport,
} from '../client/store';
import { createHttpTransport } from '../client/transport';

export interface InteractionProviderProps<View> {
  workspaceId: string;
  initialView: View;
  transport?: InteractionTransport<View>;
  children: React.ReactNode;
}

export const InteractionContext = createContext<InteractionStore<any> | null>(null);

export function InteractionProvider<View>({
  workspaceId,
  initialView,
  transport,
  children,
}: InteractionProviderProps<View>) {
  const effectiveTransport = useMemo(() => {
    return transport ?? createHttpTransport<View>({ workspaceId });
  }, [transport, workspaceId]);

  const store = useMemo(() => {
    return createInteractionStore<View>({
      workspaceId,
      initialView,
      transport: effectiveTransport,
    });
  }, [workspaceId, initialView, effectiveTransport]);

  const connectedRef = useRef(false);

  useEffect(() => {
    if (!connectedRef.current) {
      connectedRef.current = true;
      void store.connect();
    }
    return () => {
      store.disconnect();
      connectedRef.current = false;
    };
  }, [store]);

  return (
    <InteractionContext.Provider value={store}>
      {children}
    </InteractionContext.Provider>
  );
}

export function useInteractionStore<View = unknown>(): InteractionStore<View> {
  const store = useContext(InteractionContext);
  if (!store) {
    throw new Error('useInteractionStore must be used within an InteractionProvider');
  }
  return store as InteractionStore<View>;
}
