# interaction-builder

Deterministic conversational interaction engine with transactional persistence, tool execution, and UI synchronization.

## Features

- **Bidirectional Chat ↔ UI Synchronization**: Server-orchestrated actions update live workspace state; direct user edits and AI tool mutations use the exact same validated commit path.
- **Transactional Durability**: Monotonically advancing workspace revisions and sequence counters, idempotent intake, and event journals.
- **Worker Leases & Fencing**: Safe background execution using `FOR UPDATE SKIP LOCKED` and token-fenced commits to prevent stale or expired workers from mutating state.
- **Crash Recovery & Step Journaling**: Interrupted assistant runs resume without repeating committed tool mutations.
- **Subpath Architecture**: Cleanly separated entry points with zero bloat or transitive server/database leakage into browser bundles.

## Subpath Exports

| Export | Environment | Description |
|---|---|---|
| `interaction-builder/core` | Browser & Server | Envelopes, message parts, entity refs, receipts, events, schemas, and pure client reducer. |
| `interaction-builder/runtime` | Server only | Handlers, dispatcher, assistant runner loop, action service, in-memory double, and repository interfaces. |
| `interaction-builder/client` | Browser | External store, HTTP transport, and SSE streaming parser. |
| `interaction-builder/react` | React (Browser) | `InteractionProvider`, `useInteractionState`, `useWorkspaceView`, `useSendMessage`, `useDispatchAction`, etc. |
| `interaction-builder/adapters/pg` | Server (Node.js) | Pure PostgreSQL adapter using `pg.Pool` without any ORM dependency. |
| `interaction-builder/adapters/http` | Server (Web/Next.js) | Standard Web Fetch `Request` / `Response` router for `/api/interaction/v1/*`. |
| `interaction-builder/testkit` | Tests | `MemoryInteractionRepository`, scripted mock models, and reference domain fixtures. |

## Quick Start

### 1. Database Schema
Run the migration located in `migrations/001_interaction_schema.sql` against your PostgreSQL database. It provisions the 8 required interaction tables:
- `interaction_workspaces`
- `interaction_requests`
- `interaction_events`
- `interaction_outbox`
- `interaction_messages`
- `interaction_runs` (with partial unique active index)
- `interaction_steps`
- `interaction_proposals`

### 2. Define a Domain
```ts
import { z } from 'zod';
import type { DomainDefinition, DomainActionPlan } from 'interaction-builder/core';

export const documentSchema = z.object({
  title: z.string(),
  content: z.string(),
});
export type DocumentState = z.infer<typeof documentSchema>;

export const documentDomain: DomainDefinition<DocumentState> = {
  id: 'document',
  version: 1,
  initialState: (bootstrap) => documentSchema.parse(bootstrap),
  plan: (state, actionInput, ctx) => {
    // Return pure next state + change receipts
    return {
      nextState: { ...state, title: (actionInput as any).title },
      changed: [],
      invalidated: [],
      summary: 'Updated title',
      undoable: true,
    };
  },
};
```

### 3. Server Route
```ts
import { createPgInteractionRepository } from 'interaction-builder/adapters/pg';
import { createInteractionHandlers } from 'interaction-builder/runtime';
import { dispatchInteraction } from 'interaction-builder/adapters/http';
import { documentDomain } from './domain';

const repo = createPgInteractionRepository({
  connectionString: process.env.DATABASE_URL!,
});

const handlers = createInteractionHandlers({
  repo,
  domains: new Map([[documentDomain.id, documentDomain]]),
});

export async function handleRequest(request: Request, segments: string[], getUserId: () => Promise<string | null>) {
  return dispatchInteraction(request, segments, getUserId, handlers);
}
```

### 4. Client Integration
```tsx
import { InteractionProvider, useWorkspaceView, useSendMessage } from 'interaction-builder/react';

function DocumentEditor() {
  const doc = useWorkspaceView<DocumentState>();
  const sendMessage = useSendMessage();

  return (
    <div>
      <h1>{doc.title}</h1>
      <button onClick={() => sendMessage('Make this title more punchy')}>
        Ask Assistant
      </button>
    </div>
  );
}

export function App({ workspaceId, initialDoc }: { workspaceId: string; initialDoc: DocumentState }) {
  return (
    <InteractionProvider workspaceId={workspaceId} initialView={initialDoc}>
      <DocumentEditor />
    </InteractionProvider>
  );
}
```

## Running the Standalone Agenda Example

```bash
npx tsx examples/agenda/run.ts
```

This exercises the full lifecycle:
1. Creates an agenda workspace.
2. Appends user messages.
3. Claims worker leases and executes multi-step tool calls.
4. Updates canonical state and receipts.
5. Applies direct user UI mutations with conflict detection.
