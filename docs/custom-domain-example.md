# Custom Domain Walkthrough: Meeting Agenda

This walkthrough demonstrates how to build an independent, fully functional Meeting Agenda domain with conversational AI tools, manual UI actions, and optimistic updates.

The full working source code for this example is included in the package under [`examples/agenda/`](../examples/agenda/).

---

## 1. Define the Agenda Domain Schema

```ts
// agenda.domain.ts
import { z } from 'zod';
import { type DomainActionPlan } from 'interaction-builder/core';

export const agendaItemSchema = z.object({
  id: z.string(),
  version: z.number().int().nonnegative(),
  title: z.string(),
  durationMinutes: z.number().int().positive(),
  presenter: z.string(),
  pinned: z.boolean(),
});

export const agendaWorkspaceSchema = z.object({
  schemaVersion: z.literal(1),
  meetingTitle: z.string(),
  date: z.string(),
  items: z.array(agendaItemSchema),
});

export type AgendaWorkspace = z.infer<typeof agendaWorkspaceSchema>;

export const agendaActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_meeting_title'), title: z.string() }),
  z.object({ type: z.literal('edit_item'), itemId: z.string(), durationMinutes: z.number().optional() }),
  z.object({ type: z.literal('set_item_pin'), itemId: z.string(), pinned: z.boolean() }),
]);

export type AgendaAction = z.infer<typeof agendaActionSchema>;
```

---

## 2. Implement the Pure Planning Function

```ts
export const agendaDomain = {
  id: 'agenda',
  version: 1,
  initialState: (b: unknown) => agendaWorkspaceSchema.parse(b),
  plan: (state: AgendaWorkspace, actionInput: unknown, context: any): DomainActionPlan<AgendaWorkspace> => {
    const action = agendaActionSchema.parse(actionInput);
    if (context.expectedRevision !== context.currentRevision) {
      throw new Error('STALE_WORKSPACE');
    }

    const next = structuredClone(state);
    if (action.type === 'set_meeting_title') {
      next.meetingTitle = action.title;
      return { nextState: next, changed: [], invalidated: ['meeting'], summary: 'Updated title', undoable: true };
    }

    if (action.type === 'set_item_pin') {
      const item = next.items.find(i => i.id === action.itemId);
      if (!item) throw new Error('ITEM_NOT_FOUND');
      item.pinned = action.pinned;
      item.version += 1;
      return {
        nextState: next,
        changed: [{ kind: 'item', id: item.id, version: item.version }],
        invalidated: ['items'],
        summary: `${action.pinned ? 'Pinned' : 'Unpinned'} ${item.title}`,
        undoable: true,
      };
    }

    throw new Error('UNHANDLED_ACTION');
  },
};
```

---

## 3. Implement AI Tools with Revision Tracking & Deterministic IDs

```ts
// agenda.tools.ts
import { z } from 'zod';
import { tool } from 'ai';
import { deterministicUuid } from 'interaction-builder/runtime';

export function createAgendaAiTools(deps: any) {
  let currentRevision = deps.observedRevision;

  const commit = async (action: any, meta?: any) => {
    const res = await deps.repo.commitAction({
      workspaceId: deps.workspaceId,
      ownerId: deps.ownerId,
      expectedRevision: currentRevision,
      envelope: {
        actionId: meta?.requestId ? deterministicUuid('action:' + meta.requestId) : crypto.randomUUID(),
        workspaceId: deps.workspaceId,
        expectedRevision: currentRevision,
        entityVersions: [],
        action,
      },
      plan: deps.domain.plan,
      runFence: deps.runFence,
      requestId: meta?.requestId,
    });
    // Advance this run's tracked revision
    currentRevision = res.revision;
    return res;
  };

  return {
    set_meeting_title: tool({
      description: 'Update meeting title',
      inputSchema: z.object({ title: z.string() }),
      execute: async ({ title }, { toolCallId }) => {
        return deps.onToolStep
          ? deps.onToolStep('set_meeting_title', { title }, meta => commit({ type: 'set_meeting_title', title }, meta))
          : commit({ type: 'set_meeting_title', title });
      },
    }),
  };
}
```

---

## 4. Render React UI

```tsx
// agenda.ui.tsx
import React, { useState } from 'react';
import { InteractionProvider, useWorkspaceView, useDispatchAction, useSendMessage } from 'interaction-builder/react';

export function AgendaApp({ workspaceId, initialAgenda }: any) {
  return (
    <InteractionProvider workspaceId={workspaceId} initialView={initialAgenda}>
      <AgendaViewer />
    </InteractionProvider>
  );
}

function AgendaViewer() {
  const agenda = useWorkspaceView<AgendaWorkspace>();
  const dispatchAction = useDispatchAction<AgendaAction>();

  return (
    <div>
      <h1>{agenda.meetingTitle}</h1>
      <ul>
        {agenda.items.map(item => (
          <li key={item.id}>
            {item.title} ({item.durationMinutes}m) {item.pinned ? '📌' : ''}
            <button onClick={() => dispatchAction({ type: 'set_item_pin', itemId: item.id, pinned: !item.pinned })}>
              {item.pinned ? 'Unpin' : 'Pin'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```
