import { reduceInteraction, type InteractionClientState } from '../core/reducer';
import type { InteractionMessage } from '../core/contracts';

export interface WorkspaceSnapshot<View> {
  workspaceId: string;
  revision: number;
  cursor: number;
  snapshot: View;
  messages?: InteractionMessage[];
}

export interface CommitResponse<View> {
  revision: number;
  cursor: number;
  snapshot: View;
  receipt: { receiptId: string; summary: string };
}

export class TransportError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

/** Host/transport-agnostic; default fetch implementation lives in transport.ts. */
export interface InteractionTransport<View> {
  getWorkspace(): Promise<WorkspaceSnapshot<View>>;
  commit(envelope: unknown, idempotencyKey: string): Promise<CommitResponse<View>>;
  sendMessage?(message: { id: string; parts: unknown[] }, idempotencyKey: string): Promise<{ message: unknown; cursor: number }>;
  runAssistant?(): Promise<{ success: boolean; text?: string }>;
  /** Open a bounded event stream after `cursor`. Returns closer. onClose fires when stream ends/fails. */
  openEvents(cursor: number, onEvent: (event: unknown) => void, onClose: () => void): () => void;
}

export interface StoreState<View> extends InteractionClientState<View> {
  lastReceipt: { actionId: string; summary: string } | null;
  lastError: { actionId: string; code: string } | null;
}

export interface InteractionStore<View> {
  getState(): StoreState<View>;
  subscribe(fn: () => void): () => void;
  connect(): Promise<void>;
  disconnect(): void;
  /** Same typed-action path the chat/tool loop uses server-side. Resolves with ok flag. */
  dispatchAction(action: unknown, entityVersions?: { kind: string; id: string; version: number }[]): Promise<boolean>;
  sendMessage(parts: unknown[]): Promise<boolean>;
  runAssistant(): Promise<boolean>;
}

export function createInteractionStore<View>(opts: {
  workspaceId: string;
  initialView: View;
  transport: InteractionTransport<View>;
  newId?: () => string;
  reconnectDelayMs?: number;
}): InteractionStore<View> {
  const { workspaceId, transport } = opts;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const reconnectDelay = opts.reconnectDelayMs ?? 500;
  let state: StoreState<View> = {
    workspaceId,
    revision: 0,
    sequence: 0,
    view: opts.initialView,
    messages: [],
    connection: 'connecting',
    pending: {},
    lastReceipt: null,
    lastError: null,
  };
  const subs = new Set<() => void>();
  let closeStream: (() => void) | null = null;
  let stopped = false;
  let resnapshotting: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const set = (next: StoreState<View>) => {
    state = next;
    subs.forEach(f => f());
  };
  const apply = (e: Parameters<typeof reduceInteraction<View>>[1]) =>
    set({ ...state, ...reduceInteraction(state, e) });

  function resnapshot(): Promise<void> {
    resnapshotting ??= transport
      .getWorkspace()
      .then(s => {
        if (s.revision >= state.revision) {
          viewRevision = s.revision;
          apply({
            kind: 'snapshot',
            workspaceId,
            revision: s.revision,
            sequence: Math.max(s.cursor, state.sequence),
            view: s.snapshot,
            messages: s.messages ?? state.messages,
          });
        }
      })
      .finally(() => {
        resnapshotting = null;
      });
    return resnapshotting;
  }

  function open() {
    if (stopped) return;
    closeStream?.();
    closeStream = transport.openEvents(state.sequence, onServerEvent, onStreamClose);
  }

  function onServerEvent(event: unknown) {
    const before = state;
    apply({ kind: 'server', event });
    if (state.connection === 'reset_required') {
      void resnapshot()
        .then(open)
        .catch(() => scheduleReopen());
      return;
    }
    // Committed by someone else (chat/other tab): canonical view must be refetched; own commits already advanced revision.
    if (
      state.revision > before.revision &&
      (event as { type?: string }).type === 'workspace.committed' &&
      !viewCoversRevision(state.revision)
    ) {
      void resnapshot().catch(() => undefined);
    }
  }

  // Revision we already hold a view for (set by our own commit/snapshot).
  let viewRevision = 0;
  const viewCoversRevision = (rev: number) => rev <= viewRevision;

  function scheduleReopen() {
    if (stopped) return;
    apply({ kind: 'connection', value: 'reconnecting' });
    timer = setTimeout(() => {
      void resnapshot()
        .catch(() => undefined)
        .finally(open);
    }, reconnectDelay);
  }

  function onStreamClose() {
    if (!stopped) scheduleReopen();
  }

  return {
    getState: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    async connect() {
      stopped = false;
      const s = await transport.getWorkspace();
      viewRevision = s.revision;
      apply({
        kind: 'snapshot',
        workspaceId,
        revision: s.revision,
        sequence: s.cursor,
        view: s.snapshot,
        messages: s.messages ?? [],
      });
      open();
    },
    disconnect() {
      stopped = true;
      if (timer) clearTimeout(timer);
      closeStream?.();
      closeStream = null;
    },
    async dispatchAction(action, entityVersions = []) {
      const actionId = newId();
      apply({ kind: 'request_pending', actionId });
      try {
        const res = await transport.commit(
          { actionId, workspaceId, expectedRevision: state.revision, entityVersions, action },
          actionId
        );
        if (res.revision > state.revision) {
          viewRevision = res.revision;
          // Commit response carries authoritative view. Keep sequence monotonic with stream.
          set({
            ...state,
            revision: res.revision,
            view: res.snapshot,
            sequence: Math.max(state.sequence, res.cursor),
            pending: omit(state.pending, actionId),
            lastReceipt: { actionId, summary: res.receipt.summary },
            lastError: null,
          });
        } else {
          set({ ...state, pending: omit(state.pending, actionId) });
        }
        return true;
      } catch (e) {
        const code = e instanceof TransportError ? e.code : 'NETWORK';
        apply({ kind: 'request_failed', actionId });
        set({ ...state, lastError: { actionId, code } });
        if (code === 'CONFLICT') void resnapshot().catch(() => undefined);
        return false;
      }
    },
    async sendMessage(parts) {
      const messageId = newId();
      if (!transport.sendMessage) return false;
      try {
        await transport.sendMessage({ id: messageId, parts }, messageId);
        return true;
      } catch (e) {
        const code = e instanceof TransportError ? e.code : 'NETWORK';
        set({ ...state, lastError: { actionId: messageId, code } });
        return false;
      }
    },
    async runAssistant() {
      if (!transport.runAssistant) return false;
      try {
        await transport.runAssistant();
        return true;
      } catch {
        return false;
      }
    },
  };
}

function omit<T extends Record<string, unknown>>(o: T, k: string): T {
  const { [k]: _drop, ...rest } = o;
  return rest as T;
}
