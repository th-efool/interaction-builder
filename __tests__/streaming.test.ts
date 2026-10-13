import { describe, expect, it } from 'vitest';
import { createAiSdkModelAdapter } from '../src/adapters/ai';
import { MockLanguageModelV4 } from 'ai/test';

describe('AI SDK Streaming & Tool Lifecycle Callbacks', () => {
  it('invokes tool lifecycle hooks before and after tool execution', async () => {
    const events: string[] = [];

    const mockModel = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'test_tool',
            input: JSON.stringify({ arg: 'val' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      }),
    });

    const adapter = createAiSdkModelAdapter(mockModel, {
      onToolCallStart: (toolName, callId) => {
        events.push(`start:${toolName}:${callId}`);
      },
      onToolCallEnd: (toolName, callId) => {
        events.push(`end:${toolName}:${callId}`);
      },
    });

    let toolExecuted = false;
    const tools = {
      test_tool: {
        execute: async () => {
          events.push('exec');
          toolExecuted = true;
          return { ok: true };
        },
      },
    };

    // First step calls tool, model returns output
    try {
      await adapter.executeTurn({
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Run tool' }],
        tools,
        maxSteps: 1,
      });
    } catch {
      // Mock model stops after step
    }

    expect(toolExecuted).toBe(true);
    expect(events).toEqual(['start:test_tool:call-1', 'exec', 'end:test_tool:call-1']);
  });
});
