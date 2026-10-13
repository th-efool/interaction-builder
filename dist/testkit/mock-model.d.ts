import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { InteractionModelAdapter } from '../runtime/runner';
export interface ScriptedTurn {
    toolCalls?: Array<{
        toolName: string;
        toolCallId?: string;
        input: Record<string, unknown>;
    }>;
    text?: string;
}
export declare function createScriptedModelAdapter(turns: ScriptedTurn[]): InteractionModelAdapter;
export declare function createScriptedLanguageModel(turns: ScriptedTurn[]): LanguageModel;
export { MockLanguageModelV4 };
//# sourceMappingURL=mock-model.d.ts.map