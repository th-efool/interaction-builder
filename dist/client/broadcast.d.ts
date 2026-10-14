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
export type CrossTabMessage = CrossTabEventMessage | CrossTabHeartbeatMessage | CrossTabYieldMessage;
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
export declare function createCrossTabCoordinator(opts: CrossTabOptions): CrossTabCoordinator;
//# sourceMappingURL=broadcast.d.ts.map