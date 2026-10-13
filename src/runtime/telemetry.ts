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

export function createCompositeTelemetry(ports: ReadonlyArray<InteractionTelemetryPort>): InteractionTelemetryPort {
  return {
    onActionStart(e) {
      for (const p of ports) p.onActionStart?.(e);
    },
    onActionEnd(e) {
      for (const p of ports) p.onActionEnd?.(e);
    },
    onTurnStart(e) {
      for (const p of ports) p.onTurnStart?.(e);
    },
    onTurnEnd(e) {
      for (const p of ports) p.onTurnEnd?.(e);
    },
  };
}
