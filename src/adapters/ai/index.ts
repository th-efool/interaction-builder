import { generateText, streamText, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';
import type {
  InteractionModelAdapter,
  InteractionModelTurnInput,
  InteractionModelTurnOutput,
} from '../../runtime/runner';

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

export function createAiSdkModelAdapter(
  model: LanguageModel,
  options?: AiSdkAdapterOptions
): InteractionModelAdapter {
  return {
    async executeTurn(input: InteractionModelTurnInput): Promise<InteractionModelTurnOutput> {
      const messages: ModelMessage[] = input.messages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      }));

      let fatalToolError: unknown = null;
      const ac = new AbortController();
      const abortSignal = AbortSignal.any([
        ac.signal,
        ...(options?.signal ? [options.signal] : []),
        ...(options?.timeoutMs ? [AbortSignal.timeout(options.timeoutMs)] : []),
      ]);
      const policy = { maxRetries: options?.maxRetries, maxOutputTokens: options?.maxOutputTokens };

      const wrappedTools: Record<string, any> = {};
      for (const [name, t] of Object.entries(input.tools)) {
        if (t && typeof t.execute === 'function') {
          const origExecute = t.execute;
          wrappedTools[name] = {
            ...t,
            execute: async (args: any, context: any) => {
              options?.onToolCallStart?.(name, context?.toolCallId);
              try {
                const out = await origExecute(args, context);
                options?.onToolCallEnd?.(name, context?.toolCallId);
                return out;
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

      if (options?.streaming && options?.onChunk) {
        try {
          const streamResult = streamText({
            ...policy,
            model,
            system: input.systemPrompt,
            messages,
            tools: wrappedTools,
            abortSignal,
            stopWhen: stepCountIs(input.maxSteps ?? 5),
          });

          for await (const chunk of streamResult.textStream) {
            options.onChunk(chunk);
          }

          const fullText = await streamResult.text;
          const steps = await streamResult.steps;
          const streamUsage = await (streamResult as any).usage;

          if (fatalToolError) throw fatalToolError;

          return {
            text: fullText,
            stepsCount: steps?.length ?? 1,
            usage: streamUsage ? {
              promptTokens: streamUsage.promptTokens ?? streamUsage.inputTokens?.total,
              completionTokens: streamUsage.completionTokens ?? streamUsage.outputTokens?.total,
              totalTokens: streamUsage.totalTokens ?? (((streamUsage.inputTokens?.total ?? 0) + (streamUsage.outputTokens?.total ?? 0)) || undefined),
            } : undefined,
          };
        } catch (err) {
          if (fatalToolError) throw fatalToolError;
          throw err;
        }
      }

      let result;
      try {
        result = await generateText({
          ...policy,
          model,
          system: input.systemPrompt,
          messages,
          tools: wrappedTools,
          abortSignal,
          stopWhen: stepCountIs(input.maxSteps ?? 5),
        });
      } catch (err) {
        if (fatalToolError) throw fatalToolError;
        throw err;
      }

      if (fatalToolError) {
        throw fatalToolError;
      }

      const resUsage = (result as any).usage;
      return {
        text: result.text,
        stepsCount: result.steps?.length ?? 1,
        usage: resUsage ? {
          promptTokens: resUsage.promptTokens ?? resUsage.inputTokens?.total,
          completionTokens: resUsage.completionTokens ?? resUsage.outputTokens?.total,
          totalTokens: resUsage.totalTokens ?? (((resUsage.inputTokens?.total ?? 0) + (resUsage.outputTokens?.total ?? 0)) || undefined),
        } : undefined,
      };
    },
  };
}

export type { LanguageModel };
