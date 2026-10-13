# React & Client Store Guide

Exported from:
- `interaction-builder/client`: Browser external store & HTTP/SSE transport
- `interaction-builder/react`: React Context Provider and typed hooks

---

## 1. Provider Setup

Wrap your application or screen in `<InteractionProvider>`:

```tsx
import { InteractionProvider } from 'interaction-builder/react';

export function WorkspaceScreen({ workspaceId, initialData }) {
  return (
    <InteractionProvider
      workspaceId={workspaceId}
      initialView={initialData}
    >
      <MyWorkspaceView />
      <MyChatPane />
    </InteractionProvider>
  );
}
```

The provider automatically connects to `/api/interaction/v1/workspaces/:id` and opens the Server-Sent Events stream `/api/interaction/v1/workspaces/:id/events`.

---

## 2. Typed Workspace Hooks

### Reading Workspace State
```tsx
import { useWorkspaceView, useWorkspaceRevision } from 'interaction-builder/react';

function Header() {
  const data = useWorkspaceView<MyDomainState>();
  const revision = useWorkspaceRevision();

  return (
    <div>
      <h1>{data.title}</h1>
      <span>Revision: {revision}</span>
    </div>
  );
}
```

### Dispatching Domain Actions
Direct UI actions (e.g., clicking a button or moving a card) use `useDispatchAction`:

```tsx
import { useDispatchAction } from 'interaction-builder/react';

function RenameButton() {
  const dispatchAction = useDispatchAction<MyDomainAction>();

  return (
    <button onClick={() => dispatchAction({ type: 'rename', title: 'New Name' })}>
      Rename
    </button>
  );
}
```

Actions are dispatched with an optimistic update immediately, and confirmed via server change receipt.

### Conversational Messaging
Sending messages to the assistant:

```tsx
import { useWorkspaceMessages, useSendMessage } from 'interaction-builder/react';

function ChatBox() {
  const messages = useWorkspaceMessages();
  const sendMessage = useSendMessage();

  return (
    <div>
      {messages.map(m => (
        <p key={m.id}><b>{m.role}:</b> {m.parts.map(p => p.text).join('')}</p>
      ))}
      <button onClick={() => sendMessage('Please organize the items')}>
        Ask Assistant
      </button>
    </div>
  );
}
```

---

## 3. Real-Time Streaming & Reconnection

The client uses `createHttpTransport` and Server-Sent Events (SSE).
- Every event carries a monotonic `sequence` cursor.
- If the connection drops, it reconnects using `?after=<cursor>`, receiving any missed events seamlessly.
- Optimistic actions matching incoming confirmed events are resolved without visual flickering.
