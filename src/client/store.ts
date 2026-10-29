import { reduceInteraction, type InteractionClientState } from '../core/reducer';
import type { InteractionMessage } from '../core/contracts';
import { createCrossTabCoordinator, type CrossTabCoordinator } from './broadcast';

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

export interface HistoryEntry<View> {
  revision: number;
  view: View;
  summary?: string;
  action?: unknown;
  timestamp: number;
}

export interface StoreHistory<View> {
  past: HistoryEntry<View>[];
  future: HistoryEntry<View>[];
  canUndo: boolean;
  canRedo: boolean;
  isTimeTraveling: boolean;
  activeRevision: number;
}

export interface StoreState<View> extends InteractionClientState<View> {
  lastReceipt: { actionId: string; summary: string } | null;
  lastError: { actionId: string; code: string } | null;
  isTimeTraveling?: boolean;
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
  /** History & Time-Travel */
  getHistory(): StoreHistory<View>;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): boolean;
  redo(): boolean;
  timeTravel(revision: number): boolean;
  resetTimeTravel(): void;
  /** Cross-tab coordination inspection */
  isCrossTabLeader?(): boolean;
}

export interface InteractionStoreOptions<View> {
  workspaceId: string;
  initialView: View;
  initialRevision?: number;
  transport: InteractionTransport<View>;
  newId?: () => string;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  backoffMultiplier?: number;
  jitter?: boolean;
  enableHistory?: boolean;
  maxHistory?: number;
  crossTabSync?: boolean;
  conflictResolution?: 'reject' | 'rebase';
  plan?: (state: View, action: unknown, context: any) => { nextState: View; [k: string]: any };
}

export function createInteractionStore<View>(opts: InteractionStoreOptions<View>): InteractionStore<View> {
  const { workspaceId, transport } = opts;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const reconnectDelay = opts.reconnectDelayMs ?? 500;
  const maxReconnectDelay = opts.maxReconnectDelayMs ?? 10000;
  const backoffMultiplier = opts.backoffMultiplier ?? 1.5;
  const withJitter = opts.jitter ?? true;
  const enableHistory = opts.enableHistory ?? true;
  const maxHistory = opts.maxHistory ?? 50;

  let state: StoreState<View> = {
    workspaceId,
    revision: opts.initialRevision ?? 0,
    sequence: 0,
    view: opts.initialView,
    messages: [],
    connection: 'connecting',
    pending: {},
    lastReceipt: null,
    lastError: null,
    isTimeTraveling: false,
  };

  const subs = new Set<() => void>();
  let closeStream: (() => void) | null = null;
  let stopped = false;
  let resnapshotting: Promise<void> | null = null;
  let resnapshotAgain = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;

  // History & Time-Travel tracking
  const past: HistoryEntry<View>[] = [];
  const future: HistoryEntry<View>[] = [];
  let isTimeTraveling = false;
  let liveView: View = opts.initialView;
  let liveRevision: number = opts.initialRevision ?? 0;

  let historySnapshot = {
    past: [] as HistoryEntry<View>[],
    future: [] as HistoryEntry<View>[],
    canUndo: false,
    canRedo: false,
    isTimeTraveling: false,
    activeRevision: state.revision,
  };

  function updateHistorySnapshot() {
    historySnapshot = {
      past: [...past],
      future: [...future],
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      isTimeTraveling,
      activeRevision: state.revision,
    };
  }

  function pushHistory(entry: HistoryEntry<View>) {
    if (!enableHistory) return;
    past.push(entry);
    if (past.length > maxHistory) past.shift();
    future.length = 0;
    updateHistorySnapshot();
  }

  function recordViewAdvance(nextRev: number, nextView: View, summary?: string, action?: unknown) {
    if (nextRev > liveRevision) {
      pushHistory({
        revision: liveRevision,
        view: liveView,
        summary,
        action,
        timestamp: Date.now(),
      });
      liveRevision = nextRev;
      liveView = nextView;
    }
  }

  // Cross-Tab Coordinator
  let coordinator: CrossTabCoordinator | null = null;
  if (opts.crossTabSync) {
    coordinator = createCrossTabCoordinator({ workspaceId });
    coordinator.onEvent(event => {
      onServerEvent(event);
    });
    coordinator.onLeadershipChange(isLeader => {
      if (isLeader) {
        open();
      } else {
        closeStream?.();
        closeStream = null;
      }
    });
  }

  const set = (next: StoreState<View>) => {
    const revChanged = state.revision !== next.revision || state.isTimeTraveling !== next.isTimeTraveling;
    state = next;
    if (revChanged) {
      updateHistorySnapshot();
    }
    subs.forEach(f => f());
  };
  const apply = (e: Parameters<typeof reduceInteraction<View>>[1]) =>
    set({ ...state, ...reduceInteraction(state, e) });

  function resnapshot(): Promise<void> {
    if (resnapshotting) {
      resnapshotAgain = true;
      return resnapshotting;
    }
    resnapshotting ??= transport
      .getWorkspace()
      .then(s => {
        if (s.revision >= state.revision) {
          viewRevision = s.revision;
          recordViewAdvance(s.revision, s.snapshot);
          if (!isTimeTraveling) {
            apply({
              kind: 'snapshot',
              workspaceId,
              revision: s.revision,
              sequence: Math.max(s.cursor, state.sequence),
              view: s.snapshot,
              messages: s.messages ?? state.messages,
            });
          }
        }
      })
      .finally(() => {
        resnapshotting = null;
        // A newer event may have made the in-flight response obsolete. Coalesce
        // its follow-up, not just its request, or the final view stays stale.
        const again = resnapshotAgain;
        resnapshotAgain = false;
        if (again && !stopped && viewRevision < state.revision) {
          void resnapshot().catch(() => scheduleReopen());
        }
      });
    return resnapshotting;
  }

  function open() {
    if (stopped) return;
    if (coordinator && !coordinator.isLeader()) return;
    closeStream?.();
    closeStream = transport.openEvents(state.sequence, onServerEvent, onStreamClose);
  }

  function onServerEvent(event: unknown) {
    reconnectAttempts = 0;
    if (coordinator && coordinator.isLeader()) {
      coordinator.broadcastEvent(event);
    }
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
  let viewRevision = opts.initialRevision ?? 0;
  const viewCoversRevision = (rev: number) => rev <= viewRevision;

  function scheduleReopen() {
    if (stopped) return;
    if (coordinator && !coordinator.isLeader()) return;
    apply({ kind: 'connection', value: 'reconnecting' });
    const base = reconnectDelay * Math.pow(backoffMultiplier, reconnectAttempts);
    const capped = Math.min(maxReconnectDelay, base);
    const jitterFactor = withJitter ? 1 + (Math.random() * 0.3 - 0.15) : 1;
    const finalDelay = Math.max(1, Math.round(capped * jitterFactor));
    reconnectAttempts++;

    timer = setTimeout(() => {
      void resnapshot()
        .catch(() => undefined)
        .finally(open);
    }, finalDelay);
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
      reconnectAttempts = 0;
      if (opts.initialView !== undefined && opts.initialRevision !== undefined) {
        viewRevision = opts.initialRevision;
        liveRevision = opts.initialRevision;
        liveView = opts.initialView;
        apply({
          kind: 'snapshot',
          workspaceId,
          revision: opts.initialRevision,
          sequence: 0,
          view: opts.initialView,
          messages: [],
        });
        open();
      } else {
        const s = await transport.getWorkspace();
        viewRevision = s.revision;
        liveRevision = s.revision;
        liveView = s.snapshot;
        apply({
          kind: 'snapshot',
          workspaceId,
          revision: s.revision,
          sequence: s.cursor,
          view: s.snapshot,
          messages: s.messages ?? [],
        });
        open();
      }
    },
    disconnect() {
      stopped = true;
      if (timer) clearTimeout(timer);
      closeStream?.();
      closeStream = null;
      coordinator?.destroy();
      coordinator = null;
    },
    async dispatchAction(action, entityVersions = []) {
      const actionId = newId();
      apply({ kind: 'request_pending', actionId });

      let optimisticApplied = false;
      const priorState = state;
      if (opts.plan && !isTimeTraveling) {
        try {
          const planResult = opts.plan(state.view, action, {
            actionId,
            workspaceId,
            expectedRevision: state.revision,
            currentRevision: state.revision,
            entityVersions: new Map(entityVersions.map(v => [v.id, v.version])),
          });
          if (planResult && planResult.nextState) {
            optimisticApplied = true;
            set({
              ...state,
              view: planResult.nextState,
              pending: { ...state.pending, [actionId]: 'pending' },
            });
          }
        } catch {
          // If optimistic plan fails locally, proceed with standard server commit
        }
      }

      try {
        const res = await transport.commit(
          { actionId, workspaceId, expectedRevision: state.revision, entityVersions, action },
          actionId
        );
        if (res.revision > state.revision) {
          viewRevision = res.revision;
          recordViewAdvance(res.revision, res.snapshot, res.receipt.summary, action);
          set({
            ...state,
            revision: res.revision,
            view: res.snapshot,
            sequence: Math.max(state.sequence, res.cursor),
            pending: omit(state.pending, actionId),
            lastReceipt: { actionId, summary: res.receipt.summary },
            lastError: null,
            isTimeTraveling: false,
          });
        } else {
          set({
            ...state,
            view: res.snapshot ?? state.view,
            pending: omit(state.pending, actionId),
          });
        }
        return true;
      } catch (e) {
        const code = e instanceof TransportError ? e.code : 'NETWORK';
        if (code === 'CONFLICT' && opts.conflictResolution === 'rebase') {
          try {
            await resnapshot();
            let rebasedAction = action;
            if (opts.plan) {
              opts.plan(liveView, action, {
                actionId,
                workspaceId,
                expectedRevision: liveRevision,
                currentRevision: liveRevision,
                entityVersions: new Map(entityVersions.map(v => [v.id, v.version])),
              });
            }
            const retryActionId = newId();
            const res = await transport.commit(
              { actionId: retryActionId, workspaceId, expectedRevision: liveRevision, entityVersions, action: rebasedAction },
              retryActionId
            );
            if (res.revision > liveRevision) {
              viewRevision = res.revision;
              recordViewAdvance(res.revision, res.snapshot, res.receipt.summary, action);
              set({
                ...state,
                revision: res.revision,
                view: res.snapshot,
                sequence: Math.max(state.sequence, res.cursor),
                pending: omit(state.pending, actionId),
                lastReceipt: { actionId: retryActionId, summary: res.receipt.summary },
                lastError: null,
                isTimeTraveling: false,
              });
              return true;
            }
          } catch {
            // Rebase failed, continue to standard error handling
          }
        }
        if (optimisticApplied) {
          set({
            ...priorState,
            pending: { ...priorState.pending, [actionId]: 'failed' },
            lastError: { actionId, code },
          });
        } else {
          apply({ kind: 'request_failed', actionId });
          set({ ...state, lastError: { actionId, code } });
        }
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
    getHistory: () => historySnapshot,
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undo() {
      if (past.length === 0) return false;
      const prev = past.pop()!;
      future.unshift({
        revision: state.revision,
        view: state.view,
        timestamp: Date.now(),
      });
      isTimeTraveling = true;
      set({ ...state, revision: prev.revision, view: prev.view, isTimeTraveling: true });
      updateHistorySnapshot();
      return true;
    },
    redo() {
      if (future.length === 0) return false;
      const next = future.shift()!;
      past.push({
        revision: state.revision,
        view: state.view,
        timestamp: Date.now(),
      });
      isTimeTraveling = next.revision !== liveRevision;
      set({ ...state, revision: next.revision, view: next.view, isTimeTraveling });
      updateHistorySnapshot();
      return true;
    },
    timeTravel(rev: number) {
      if (rev === state.revision) return true;
      if (rev === liveRevision) {
        isTimeTraveling = false;
        set({ ...state, revision: liveRevision, view: liveView, isTimeTraveling: false });
        updateHistorySnapshot();
        return true;
      }
      const match = past.find(e => e.revision === rev) ?? future.find(e => e.revision === rev);
      if (!match) return false;
      isTimeTraveling = true;
      set({ ...state, revision: match.revision, view: match.view, isTimeTraveling: true });
      updateHistorySnapshot();
      return true;
    },
    resetTimeTravel() {
      if (!isTimeTraveling) return;
      isTimeTraveling = false;
      set({ ...state, revision: liveRevision, view: liveView, isTimeTraveling: false });
      updateHistorySnapshot();
    },
    isCrossTabLeader: () => (coordinator ? coordinator.isLeader() : true),
  };
}

function omit<T extends Record<string, unknown>>(o: T, k: string): T {
  const { [k]: _drop, ...rest } = o;
  return rest as T;
}
