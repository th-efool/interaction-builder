// src/adapters/ai/index.ts
import { generateText, streamText, stepCountIs } from "ai";
function createAiSdkModelAdapter(model, options) {
  return {
    async executeTurn(input) {
      const messages = input.messages.map((m) => ({
        role: m.role,
        content: m.content
      }));
      let fatalToolError = null;
      const ac = new AbortController();
      const wrappedTools = {};
      for (const [name, t] of Object.entries(input.tools)) {
        if (t && typeof t.execute === "function") {
          const origExecute = t.execute;
          wrappedTools[name] = {
            ...t,
            execute: async (args, context) => {
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
            }
          };
        } else {
          wrappedTools[name] = t;
        }
      }
      if (options?.streaming && options?.onChunk) {
        try {
          const streamResult = streamText({
            model,
            system: input.systemPrompt,
            messages,
            tools: wrappedTools,
            abortSignal: ac.signal,
            stopWhen: stepCountIs(input.maxSteps ?? 5)
          });
          for await (const chunk of streamResult.textStream) {
            options.onChunk(chunk);
          }
          const fullText = await streamResult.text;
          const steps = await streamResult.steps;
          if (fatalToolError) throw fatalToolError;
          return {
            text: fullText,
            stepsCount: steps?.length ?? 1
          };
        } catch (err) {
          if (fatalToolError) throw fatalToolError;
          throw err;
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
          stopWhen: stepCountIs(input.maxSteps ?? 5)
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
        stepsCount: result.steps?.length ?? 1
      };
    }
  };
}
export {
  createAiSdkModelAdapter
};
//# sourceMappingURL=index.js.map
