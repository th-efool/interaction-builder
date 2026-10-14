/**
 * Cross-Tab Coordination & Event Broadcasting using Web BroadcastChannel.
 * Reduces backend SSE connections from N tabs to 1 Leader tab per browser.
 */

export interface CrossTabEventMessage {
  type: 'event';
  workspaceId: string;
  tabId: string;
  event: unknown;
}

export interface CrossTabHeartbeatMessage {
  type: 'heartbeat';
  workspaceId: string;
  leaderId: string;
  timestamp: number;
}

export interface CrossTabYieldMessage {
  type: 'yield';
  workspaceId: string;
  leaderId: string;
}

export type CrossTabMessage =
  | CrossTabEventMessage
  | CrossTabHeartbeatMessage
  | CrossTabYieldMessage;

export interface CrossTabCoordinator {
  isLeader(): boolean;
  broadcastEvent(event: unknown): void;
  onEvent(handler: (event: unknown) => void): () => void;
  onLeadershipChange(handler: (isLeader: boolean) => void): () => void;
  destroy(): void;
}

export interface CrossTabOptions {
  workspaceId: string;
  tabId?: string;
  heartbeatIntervalMs?: number;
  leaderTimeoutMs?: number;
}

export function createCrossTabCoordinator(opts: CrossTabOptions): CrossTabCoordinator {
  const { workspaceId } = opts;
  const tabId = opts.tabId ?? (typeof crypto !== 'undefined' ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  const heartbeatInterval = opts.heartbeatIntervalMs ?? 1000;
  const leaderTimeout = opts.leaderTimeoutMs ?? 2500;

  if (typeof BroadcastChannel === 'undefined') {
    return {
      isLeader: () => true,
      broadcastEvent: () => {},
      onEvent: () => () => {},
      onLeadershipChange: () => () => {},
      destroy: () => {},
    };
  }

  const channel = new BroadcastChannel(`ib:crosstab:${workspaceId}`);
  let leader = false;
  let leaderId: string | null = null;
  let lastHeartbeat = Date.now();
  let destroyed = false;
  let heartbeatTimer: any = null;
  let checkTimer: any = null;

  const eventListeners = new Set<(event: unknown) => void>();
  const leadershipListeners = new Set<(isLeader: boolean) => void>();

  function notifyLeadership(next: boolean) {
    if (leader !== next) {
      leader = next;
      leadershipListeners.forEach(fn => fn(leader));
    }
  }

  function assumeLeadership() {
    if (destroyed || leader) return;
    leaderId = tabId;
    notifyLeadership(true);
    startHeartbeat();
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (destroyed || !leader) return;
      channel.postMessage({
        type: 'heartbeat',
        workspaceId,
        leaderId: tabId,
        timestamp: Date.now(),
      } satisfies CrossTabHeartbeatMessage);
    }, heartbeatInterval);
  }

  // Initial leader election: wait brief jittered window to see if a leader exists
  const initialDelay = 100 + Math.floor(Math.random() * 200);
  setTimeout(() => {
    if (destroyed) return;
    if (!leaderId) {
      assumeLeadership();
    }
  }, initialDelay);

  // Monitor leader liveness
  checkTimer = setInterval(() => {
    if (destroyed || leader) return;
    if (Date.now() - lastHeartbeat > leaderTimeout) {
      assumeLeadership();
    }
  }, leaderTimeout / 2);

  channel.onmessage = (ev: MessageEvent<CrossTabMessage>) => {
    if (destroyed) return;
    const msg = ev.data;
    if (!msg || msg.workspaceId !== workspaceId) return;

    if (msg.type === 'heartbeat') {
      lastHeartbeat = Date.now();
      if (msg.leaderId !== tabId) {
        leaderId = msg.leaderId;
        if (leader) {
          // Conflict resolution: lower tab ID yields
          if (tabId > msg.leaderId) {
            clearInterval(heartbeatTimer);
            notifyLeadership(false);
          }
        }
      }
    } else if (msg.type === 'yield') {
      if (leaderId === msg.leaderId) {
        leaderId = null;
        assumeLeadership();
      }
    } else if (msg.type === 'event') {
      if (msg.tabId !== tabId) {
        eventListeners.forEach(fn => fn(msg.event));
      }
    }
  };

  const handleUnload = () => {
    if (leader) {
      try {
        channel.postMessage({
          type: 'yield',
          workspaceId,
          leaderId: tabId,
        } satisfies CrossTabYieldMessage);
      } catch {
        // Ignored during page unload
      }
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', handleUnload);
  }

  return {
    isLeader: () => leader,
    broadcastEvent(event: unknown) {
      if (destroyed) return;
      channel.postMessage({
        type: 'event',
        workspaceId,
        tabId,
        event,
      } satisfies CrossTabEventMessage);
    },
    onEvent(handler) {
      eventListeners.add(handler);
      return () => eventListeners.delete(handler);
    },
    onLeadershipChange(handler) {
      leadershipListeners.add(handler);
      return () => leadershipListeners.delete(handler);
    },
    destroy() {
      destroyed = true;
      clearInterval(heartbeatTimer);
      clearInterval(checkTimer);
      handleUnload();
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', handleUnload);
      }
      channel.close();
    },
  };
}
