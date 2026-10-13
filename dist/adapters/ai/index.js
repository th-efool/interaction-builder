// src/adapters/ai/index.ts
import { generateText, stepCountIs } from "ai";
function createAiSdkModelAdapter(model) {
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
              try {
                return await origExecute(args, context);
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
