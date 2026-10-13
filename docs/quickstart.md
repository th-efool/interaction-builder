# Quickstart Guide

This guide walks you through setting up a complete, working Interaction Builder project from scratch in under 5 minutes.

---

## 1. Installation

Install `interaction-builder` and peer dependencies:

```bash
npm install interaction-builder zod ai
```

If you plan to use PostgreSQL for durable persistence:
```bash
npm install pg
npm install -D @types/pg
```

If you plan to use React on the client:
```bash
npm install react react-dom
```

---

## 2. Apply Database Migration

Run the provided SQL migration in `node_modules/interaction-builder/migrations/001_interaction_schema.sql` (or copy it to your migration directory).

This provisions the 8 durability tables:
- `interaction_workspaces`
- `interaction_requests`
- `interaction_events`
- `interaction_outbox`
- `interaction_messages`
- `interaction_runs` (with partial unique active index preventing multiple simultaneous assistant runs)
- `interaction_steps`
- `interaction_proposals`

---

## 3. Define Your Business Domain

Define your domain schema, actions, and pure planning function using `interaction-builder/core`:

```ts
// src/domain/kanban.ts
import { z } from 'zod';
import type { DomainDefinition, DomainActionPlan } from 'interaction-builder/core';

export const kanbanTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  column: z.enum(['todo', 'in_progress', 'done']),
});

export const kanbanWorkspaceSchema = z.object({
  schemaVersion: z.literal(1),
  boardTitle: z.string(),
  tasks: z.array(kanbanTaskSchema),
});

export type KanbanWorkspace = z.infer<typeof kanbanWorkspaceSchema>;

export const kanbanActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_board_title'), title: z.string() }),
  z.object({ type: z.literal('add_task'), id: z.string().optional(), title: z.string(), column: z.enum(['todo', 'in_progress', 'done']) }),
  z.object({ type: z.literal('move_task'), taskId: z.string(), targetColumn: z.enum(['todo', 'in_progress', 'done']) }),
]);

export type KanbanAction = z.infer<typeof kanbanActionSchema>;

export const kanbanDomain: DomainDefinition<KanbanWorkspace> = {
  id: 'kanban',
  version: 1,
  initialState: (bootstrap) => kanbanWorkspaceSchema.parse(bootstrap),
  plan: (state, actionInput, context): DomainActionPlan<KanbanWorkspace> => {
    const action = kanbanActionSchema.parse(actionInput);
    if (context.expectedRevision !== context.currentRevision) {
      throw new Error('STALE_WORKSPACE');
    }

    const nextState = structuredClone(state);
    if (action.type === 'set_board_title') {
      nextState.boardTitle = action.title;
      return {
        nextState,
        changed: [],
        invalidated: ['board'],
        summary: `Renamed board to "${action.title}"`,
        undoable: true,
      };
    }

    if (action.type === 'add_task') {
      const task = {
        id: action.id ?? crypto.randomUUID(),
        title: action.title,
        column: action.column,
      };
      nextState.tasks.push(task);
      return {
        nextState,
        changed: [{ kind: 'task', id: task.id, version: 1 }],
        invalidated: ['tasks'],
        summary: `Added task "${action.title}"`,
        undoable: true,
      };
    }

    if (action.type === 'move_task') {
      const task = nextState.tasks.find(t => t.id === action.taskId);
      if (!task) throw new Error(`Task ${action.taskId} not found`);
      task.column = action.targetColumn;
      return {
        nextState,
        changed: [{ kind: 'task', id: task.id, version: 2 }],
        invalidated: ['tasks'],
        summary: `Moved task to ${action.targetColumn}`,
        undoable: true,
      };
    }

    throw new Error('UNKNOWN_ACTION');
  },
};
```

---

## 4. Set Up Server Repository & Routes

Use standard Web Fetch Request / Response dispatcher:

```ts
// src/app/api/interaction/[...segments]/route.ts (Next.js App Router example)
import { createPgInteractionRepository } from 'interaction-builder/adapters/pg';
import { createInteractionHandlers } from 'interaction-builder/runtime';
import { dispatchInteraction } from 'interaction-builder/adapters/http';
import { kanbanDomain } from '@/src/domain/kanban';

const repo = createPgInteractionRepository({
  connectionString: process.env.DATABASE_URL!,
});

const handlers = createInteractionHandlers({
  repo,
  domains: new Map([[kanbanDomain.id, kanbanDomain]]),
});

async function getUserId(): Promise<string | null> {
  // Extract user ID from session cookie or auth header
  return 'user-123';
}

export async function GET(request: Request, { params }: { params: { segments: string[] } }) {
  return dispatchInteraction(request, params.segments, getUserId, handlers);
}

export async function POST(request: Request, { params }: { params: { segments: string[] } }) {
  return dispatchInteraction(request, params.segments, getUserId, handlers);
}
```

---

## 5. Render Interactive React UI

Use `interaction-builder/react` to mount the workspace, render optimistic updates, and dispatch actions:

```tsx
// src/components/KanbanBoard.tsx
'use client';

import React, { useState } from 'react';
import {
  InteractionProvider,
  useWorkspaceView,
  useWorkspaceMessages,
  useSendMessage,
  useDispatchAction,
} from 'interaction-builder/react';
import type { KanbanWorkspace, KanbanAction } from '@/src/domain/kanban';

export function KanbanApp({ workspaceId, initial }: { workspaceId: string; initial: KanbanWorkspace }) {
  return (
    <InteractionProvider workspaceId={workspaceId} initialView={initial}>
      <div className="flex h-screen">
        <KanbanView />
        <KanbanChat />
      </div>
    </InteractionProvider>
  );
}

function KanbanView() {
  const board = useWorkspaceView<KanbanWorkspace>();
  const dispatchAction = useDispatchAction<KanbanAction>();

  return (
    <div className="flex-1 p-6">
      <h1 className="text-2xl font-bold">{board.boardTitle}</h1>
      <div className="grid grid-cols-3 gap-4 mt-6">
        {(['todo', 'in_progress', 'done'] as const).map(col => (
          <div key={col} className="bg-gray-100 p-4 rounded-lg">
            <h2 className="font-semibold capitalize mb-3">{col.replace('_', ' ')}</h2>
            {board.tasks.filter(t => t.column === col).map(task => (
              <div key={task.id} className="p-3 bg-white shadow rounded mb-2 flex justify-between">
                <span>{task.title}</span>
                {col !== 'done' && (
                  <button
                    className="text-xs text-blue-600"
                    onClick={() => dispatchAction({
                      type: 'move_task',
                      taskId: task.id,
                      targetColumn: col === 'todo' ? 'in_progress' : 'done',
                    })}
                  >
                    Advance &rarr;
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function KanbanChat() {
  const messages = useWorkspaceMessages();
  const sendMessage = useSendMessage();
  const [input, setInput] = useState('');

  return (
    <div className="w-80 border-l p-4 flex flex-col">
      <div className="flex-1 overflow-y-auto space-y-2">
        {messages.map(m => (
          <div key={m.id} className={`p-2 rounded ${m.role === 'user' ? 'bg-blue-100' : 'bg-gray-200'}`}>
            <span className="font-bold text-xs uppercase block">{m.role}</span>
            {m.parts.map((p, i) => p.type === 'text' ? <p key={i}>{p.text}</p> : null)}
          </div>
        ))}
      </div>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!input.trim()) return;
          void sendMessage(input);
          setInput('');
        }}
        className="mt-4 flex gap-2"
      >
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask assistant..."
          className="border flex-1 p-2 rounded"
        />
        <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded">
          Send
        </button>
      </form>
    </div>
  );
}
```
