import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type {
  InteractionModelAdapter,
  InteractionModelTurnInput,
  InteractionModelTurnOutput,
} from '../runtime/runner';

export interface ScriptedTurn {
  toolCalls?: Array<{
    toolName: string;
    toolCallId?: string;
    input: Record<string, unknown>;
  }>;
  text?: string;
}

export function createScriptedModelAdapter(turns: ScriptedTurn[]): InteractionModelAdapter {
  let turnIdx = 0;
  return {
    async executeTurn(input: InteractionModelTurnInput): Promise<InteractionModelTurnOutput> {
      let stepsCount = 0;
      while (turnIdx < turns.length) {
        const turn = turns[turnIdx]!;
        turnIdx += 1;
        stepsCount += 1;

        if (turn.toolCalls && turn.toolCalls.length > 0) {
          for (const tc of turn.toolCalls) {
            const tool = input.tools[tc.toolName];
            if (!tool) {
              throw new Error(`Tool not found: ${tc.toolName}`);
            }
            if (typeof tool.execute === 'function') {
              await tool.execute(tc.input);
            }
          }
          if (turn.text) {
            return { text: turn.text, stepsCount };
          }
        } else {
          return { text: turn.text ?? 'Completed turn.', stepsCount };
        }
      }
      return { text: 'Done.', stepsCount: Math.max(1, stepsCount) };
    },
  };
}

export function createScriptedLanguageModel(turns: ScriptedTurn[]): LanguageModel {
  let turnIdx = 0;
  const defaultUsage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  };

  return new MockLanguageModelV4({
    doGenerate: async () => {
      const turn = turns[turnIdx] ?? { text: 'Done.' };
      turnIdx += 1;

      if (turn.toolCalls && turn.toolCalls.length > 0) {
        return {
          content: turn.toolCalls.map((tc, idx) => ({
            type: 'tool-call',
            toolCallId: tc.toolCallId ?? `call-${turnIdx}-${idx}`,
            toolName: tc.toolName,
            input: JSON.stringify(tc.input),
          })),
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage: defaultUsage,
          warnings: [],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: turn.text ?? 'Completed turn.',
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: defaultUsage,
        warnings: [],
      };
    },
  });
}

export { MockLanguageModelV4 };
