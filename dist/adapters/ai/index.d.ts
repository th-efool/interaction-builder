import { type LanguageModel } from 'ai';
import type { InteractionModelAdapter } from '../../runtime/runner';
export interface AiSdkAdapterOptions {
    maxRetries?: number;
    timeoutMs?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
    streaming?: boolean;
    onChunk?: (text: string) => void;
    onToolCallStart?: (toolName: string, callId?: string) => void;
    onToolCallEnd?: (toolName: string, callId?: string) => void;
}
export declare function createAiSdkModelAdapter(model: LanguageModel, options?: AiSdkAdapterOptions): InteractionModelAdapter;
export type { LanguageModel };
//# sourceMappingURL=index.d.ts.map