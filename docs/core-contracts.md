# Core Contracts & Schemas Reference

Exported from: `interaction-builder/core`

The `core` subpath is browser-safe, contains zero Node or database dependencies, and exports the authoritative types, Zod validation schemas, and the optimistic reducer.

---

## Data Contracts

### 1. Entity References (`EntityRef`)
Represents a versioned reference to an individual entity inside a workspace:

```ts
import { entityRefSchema, type EntityRef } from 'interaction-builder/core';

export const entityRefSchema = z.strictObject({
  kind: z.string().min(1).max(100),
  id: z.string().min(1).max(200),
  version: z.number().int().nonnegative(),
});
```

### 2. Action Envelope (`ActionEnvelope`)
Wraps any domain action with revision expectation and idempotency tracking:

```ts
import { actionEnvelopeSchema, type ActionEnvelope } from 'interaction-builder/core';

export const actionEnvelopeSchema = z.strictObject({
  actionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  entityVersions: z.array(entityRefSchema),
  action: z.unknown(),
});
```

### 3. Change Receipt (`ChangeReceipt`)
Returned by `commitAction` upon a successful domain state transition:

```ts
import { changeReceiptSchema, type ChangeReceipt } from 'interaction-builder/core';

export const changeReceiptSchema = z.strictObject({
  receiptId: z.string().uuid(),
  actionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  changed: z.array(entityRefSchema),
  invalidated: z.array(z.string().min(1).max(100)),
  summary: z.string().min(1).max(500),
  undoable: z.boolean(),
  createdAt: z.string().datetime(),
});
```

### 4. Message Parts (`MessagePart`)
Structured contents of chat messages between user and assistant:

```ts
import { messagePartSchema, type MessagePart } from 'interaction-builder/core';

export const messagePartSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    text: z.string().min(1).max(10_000),
  }),
  z.strictObject({
    type: z.literal('entity_ref'),
    entity: entityRefSchema,
    label: z.string().min(1).max(200).optional(),
  }),
]);
```

### 5. Interaction Events (`InteractionEvent`)
Events published over Server-Sent Events (SSE) and recorded in the event log:

```ts
export type InteractionEventType =
  | 'workspace.created'
  | 'workspace.committed'
  | 'message.accepted'
  | 'run.changed'
  | 'proposal.created'
  | 'proposal.resolved';
```

---

## Domain Definition

Every business object implements `DomainDefinition<T>`:

```ts
export interface DomainDefinition<State = unknown> {
  id: string;
  version: number;
  initialState: (bootstrap: unknown) => State;
  plan: (
    state: State,
    action: unknown,
    context: {
      actionId: string;
      workspaceId: string;
      expectedRevision: number;
      currentRevision: number;
      entityVersions: ReadonlyMap<string, number>;
    }
  ) => DomainActionPlan<State>;
}
```

---

## State Reducer (`interactionReducer`)

Pure reducer used by the client store to manage optimistic actions, confirmations, and rollbacks:

```ts
import { interactionReducer, type InteractionStoreState } from 'interaction-builder/core';

const nextStoreState = interactionReducer(previousState, {
  kind: 'request_committed',
  actionId: '...',
  revision: 2,
  cursor: 5,
});
```
