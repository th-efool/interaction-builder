import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';
import type {
  InteractionModelAdapter,
  InteractionModelTurnInput,
  InteractionModelTurnOutput,
} from '../../runtime/runner';

export function createAiSdkModelAdapter(model: LanguageModel): InteractionModelAdapter {
  return {
    async executeTurn(input: InteractionModelTurnInput): Promise<InteractionModelTurnOutput> {
      const messages: ModelMessage[] = input.messages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));

      let fatalToolError: unknown = null;
      const ac = new AbortController();

      const wrappedTools: Record<string, any> = {};
      for (const [name, t] of Object.entries(input.tools)) {
        if (t && typeof t.execute === 'function') {
          const origExecute = t.execute;
          wrappedTools[name] = {
            ...t,
            execute: async (args: any, context: any) => {
              try {
                return await origExecute(args, context);
              } catch (err) {
                fatalToolError = err;
                ac.abort(err);
                throw err;
              }
            },
          };
        } else {
          wrappedTools[name] = t;
        }
      }

      let result;
      try {
        result = await generateText({
          model,
          system: input.systemPrompt,
          messages,
          tools: wrappedTools,
          abortSignal: ac.signal,
          stopWhen: stepCountIs(input.maxSteps ?? 5),
        });
      } catch (err) {
        if (fatalToolError) throw fatalToolError;
        throw err;
      }

      if (fatalToolError) {
        throw fatalToolError;
      }

      return {
        text: result.text,
        stepsCount: result.steps?.length ?? 1,
      };
    },
  };
}

export type { LanguageModel };
