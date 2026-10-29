import type { InteractionRepository, InteractionWorkspaceRecord } from './repository';
import type { DomainDefinition } from './handlers';
import type { InteractionTelemetryPort } from './telemetry';
export interface InteractionModelMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}
export interface InteractionModelTurnInput {
    systemPrompt: string;
    messages: InteractionModelMessage[];
    tools: Record<string, any>;
    maxSteps?: number;
}
export interface InteractionModelTurnOutput {
    text: string;
    stepsCount: number;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
    };
}
export interface InteractionModelAdapter {
    executeTurn(input: InteractionModelTurnInput): Promise<InteractionModelTurnOutput>;
}
export interface ToolStepMeta {
    ordinal: number;
    requestId: string;
}
export interface AssistantRunOptions<State = unknown> {
    workspaceId: string;
    ownerId: string;
    repo: InteractionRepository;
    domain: DomainDefinition<State>;
    model: InteractionModelAdapter;
    createTools: (deps: {
        workspaceId: string;
        ownerId: string;
        repo: InteractionRepository;
        domain: DomainDefinition<State>;
        observedRevision: number;
        runFence?: {
            runId: string;
            leaseToken: string;
        };
        onToolStep?: (toolName: string, inputPayload: unknown, actionFn: (meta?: ToolStepMeta) => Promise<unknown>) => Promise<unknown>;
    }) => Record<string, any>;
    runId?: string;
    leaseToken?: string;
    observedRevision?: number;
    triggeringMessageId?: string | null;
    initialWorkspace?: InteractionWorkspaceRecord<State> | null;
    maxSteps?: number;
    systemPrompt?: string;
    signal?: AbortSignal;
    telemetry?: InteractionTelemetryPort;
}
export interface AssistantRunResult {
    success: boolean;
    assistantMessageId: string | null;
    text: string;
    stepsCount: number;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
    };
    runId?: string;
}
export declare function runAssistantTurn<State>(opts: AssistantRunOptions<State>): Promise<AssistantRunResult>;
//# sourceMappingURL=runner.d.ts.map