# Testing Guide

Exported from: `interaction-builder/testkit`

Interaction Builder includes a comprehensive testing kit that allows you to test domain logic, concurrency, assistant runs, and React components completely in-memory, without needing live PostgreSQL instances, OpenAI/Gemini API keys, or browser instances.

---

## 1. Unit Testing Domain Plans

Because the `plan` function is pure, you can test domain actions with standard Vitest or Jest:

```ts
import { describe, it, expect } from 'vitest';
import { kanbanDomain } from './domain';

describe('Kanban Domain Plan', () => {
  it('adds task and bumps version', () => {
    const initial = { schemaVersion: 1, boardTitle: 'Sprint 1', tasks: [] };
    const plan = kanbanDomain.plan(initial, { type: 'add_task', title: 'Write tests', column: 'todo' }, {
      actionId: 'test-action',
      workspaceId: 'test-ws',
      expectedRevision: 0,
      currentRevision: 0,
      entityVersions: new Map(),
    });

    expect(plan.nextState.tasks).toHaveLength(1);
    expect(plan.nextState.tasks[0].title).toBe('Write tests');
    expect(plan.summary).toContain('Added task');
  });

  it('rejects stale revisions', () => {
    const initial = { schemaVersion: 1, boardTitle: 'Sprint 1', tasks: [] };
    expect(() => {
      kanbanDomain.plan(initial, { type: 'set_board_title', title: 'New' }, {
        actionId: 'test-action',
        workspaceId: 'test-ws',
        expectedRevision: 0,
        currentRevision: 1, // Stale!
        entityVersions: new Map(),
      });
    }).toThrow('STALE_WORKSPACE');
  });
});
```

---

## 2. Testing Assistant Runs with Scripted Models

Use `createScriptedModelAdapter` or `MockLanguageModelV4` with `createAiSdkModelAdapter`:

```ts
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { MemoryInteractionRepository, runAssistantTurn } from 'interaction-builder/runtime';
import { createAiSdkModelAdapter } from 'interaction-builder/adapters/ai';

describe('Assistant Runner', () => {
  it('executes model tool calls and updates state', async () => {
    const repo = new MemoryInteractionRepository();
    const ws = await repo.createWorkspace({
      id: 'ws-1',
      ownerId: 'user-1',
      domainId: 'kanban',
      domainVersion: 1,
      initialSnapshot: { schemaVersion: 1, boardTitle: 'My Board', tasks: [] },
    });

    await repo.appendMessage({
      workspaceId: 'ws-1',
      ownerId: 'user-1',
      id: 'msg-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Rename board to Q4 Roadmap' }],
    });

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'set_board_title',
            input: JSON.stringify({ title: 'Q4 Roadmap' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
        warnings: [],
      }),
    });

    const result = await runAssistantTurn({
      workspaceId: 'ws-1',
      ownerId: 'user-1',
      repo,
      domain: kanbanDomain,
      model: createAiSdkModelAdapter(model),
      createTools: (deps) => createKanbanTools(deps),
    });

    expect(result.success).toBe(true);

    const updatedWs = await repo.loadWorkspace({ workspaceId: 'ws-1', ownerId: 'user-1' });
    expect(updatedWs?.revision).toBe(1);
    expect(updatedWs?.snapshot.boardTitle).toBe('Q4 Roadmap');
  });
});
```

---

## 3. Headless React Component Testing (jsdom)

Mount the React UI with an in-memory transport to verify button clicks, form inputs, and optimistic updates:

```tsx
// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { KanbanApp } from './KanbanApp';

describe('KanbanApp Interactive UI', () => {
  it('optimistically moves task on button click', async () => {
    // Render with mock transport
    render(<KanbanApp workspaceId="ws-1" initial={initialData} transport={fakeTransport} />);

    expect(screen.getByText('Write tests')).toBeDefined();

    const advanceButton = screen.getByRole('button', { name: /advance/i });
    await act(async () => {
      fireEvent.click(advanceButton);
    });

    // Verified DOM reflects updated state
    expect(fakeTransport.committedActions).toHaveLength(1);
  });
});
```
