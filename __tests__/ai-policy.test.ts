import { describe, it, expect, vi } from 'vitest';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createAiSdkModelAdapter } from '../src/adapters/ai';

const input = { systemPrompt: 'Be concise', messages: [{ role: 'user' as const, content: 'Hello' }], tools: {} };
describe('interactive execution policy', () => {
  it('does not retry an overloaded provider when retries are disabled', async () => {
    const generate = vi.fn().mockRejectedValue(new APICallError({ message: 'Busy', url: 'https://example.test', requestBodyValues: {}, statusCode: 503, isRetryable: true }));
    const adapter = createAiSdkModelAdapter(new MockLanguageModelV4({ doGenerate: generate }), { maxRetries: 0 });
    await expect(adapter.executeTurn(input)).rejects.toThrow('Busy');
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('aborts an unresponsive provider at its deadline', async () => {
    const model = new MockLanguageModelV4({ doGenerate: async ({ abortSignal }) => {
      await new Promise((_, reject) => {
        if (abortSignal?.aborted) reject(abortSignal.reason);
        else abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
      });
      throw new Error('unreachable');
    } });
    await expect(createAiSdkModelAdapter(model, { timeoutMs: 30, maxRetries: 0 }).executeTurn(input)).rejects.toThrow();
  });
});
