import { useCallback, useSyncExternalStore } from 'react';
import { useInteractionStore } from './provider';
import type { StoreState } from '../client/store';
import type { EntityRef } from '../core/contracts';

export function useInteractionState<View = unknown>(): StoreState<View> {
  const store = useInteractionStore<View>();
  return useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState
  );
}

export function useWorkspaceView<View = unknown>(): View {
  const state = useInteractionState<View>();
  return state.view;
}

export function useWorkspaceMessages() {
  const state = useInteractionState();
  return state.messages;
}

export function useWorkspaceConnection() {
  const state = useInteractionState();
  return state.connection;
}

export function useWorkspacePending() {
  const state = useInteractionState();
  return state.pending;
}

export function useDispatchAction<Action = unknown>() {
  const store = useInteractionStore();
  return useCallback(
    (action: Action, entityVersions?: EntityRef[]) => {
      return store.dispatchAction(action, entityVersions);
    },
    [store]
  );
}

export function useSendMessage() {
  const store = useInteractionStore();
  return useCallback(
    async (text: string, entityRefs: Array<{ entity: EntityRef; label: string }> = []) => {
      const trimmed = text.trim();
      if (!trimmed && entityRefs.length === 0) return false;
      const parts: unknown[] = [];
      if (trimmed) {
        parts.push({ type: 'text', text: trimmed });
      }
      for (const ref of entityRefs) {
        parts.push({ type: 'entity_ref', entity: ref.entity, label: ref.label });
      }
      return store.sendMessage(parts);
    },
    [store]
  );
}

export function useRunAssistant() {
  const store = useInteractionStore();
  return useCallback(() => {
    return store.runAssistant();
  }, [store]);
}
