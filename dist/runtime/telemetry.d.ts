export interface InteractionTelemetryPort {
    onActionStart?(event: {
        workspaceId: string;
        actionId: string;
        actionType: string;
        timestamp: number;
    }): void;
    onActionEnd?(event: {
        workspaceId: string;
        actionId: string;
        actionType: string;
        durationMs: number;
        success: boolean;
        revision?: number;
        error?: unknown;
    }): void;
    onTurnStart?(event: {
        workspaceId: string;
        runId: string;
        timestamp: number;
    }): void;
    onTurnEnd?(event: {
        workspaceId: string;
        runId: string;
        durationMs: number;
        success: boolean;
        stepsCount?: number;
        error?: unknown;
    }): void;
}
export declare function createCompositeTelemetry(ports: ReadonlyArray<InteractionTelemetryPort>): InteractionTelemetryPort;
//# sourceMappingURL=telemetry.d.ts.map