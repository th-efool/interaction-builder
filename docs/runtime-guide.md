# Runtime Orchestration & Execution

Exported from: `interaction-builder/runtime`

The `runtime` module contains server-side domain execution, the generic repository interface, the assistant deliberation loop, step journaling, and recovery.

---

## 1. Action Service (`planActionCommit`)

Executes an action envelope against the current state using the domain's pure `plan` function:

```ts
import { planActionCommit } from 'interaction-builder/runtime';

const result = planActionCommit({
  state: currentSnapshot,
  currentRevision: workspace.revision,
  envelope: actionEnvelope,
  plan: domain.plan,
});

// Returns:
// { state: nextState, revision: nextRevision, receipt: ChangeReceipt }
```

If `envelope.expectedRevision !== currentRevision`, `planActionCommit` immediately throws `STALE_WORKSPACE` before mutating state.

### Batch Action Commit (`planBatchActionCommit`)
Executes multiple domain actions atomically in a single pass:
```ts
import { planBatchActionCommit } from 'interaction-builder/runtime';

const result = planBatchActionCommit({
  state: currentSnapshot,
  currentRevision: workspace.revision,
  envelopes: [envelope1, envelope2],
  plan: domain.plan,
});
// Advances revision once per action, returns final state and array of receipts
```

### Telemetry & Observability (`InteractionTelemetryPort`)
Pass pluggable OpenTelemetry hooks into action and turn lifecycles:
```ts
import { createCompositeTelemetry, type InteractionTelemetryPort } from 'interaction-builder/runtime';

const otelPort: InteractionTelemetryPort = {
  onActionStart: (e) => console.log('Action started:', e.actionType),
  onActionEnd: (e) => console.log('Action ended in ms:', e.durationMs, 'success:', e.success),
  onTurnStart: (e) => console.log('Turn started:', e.runId),
  onTurnEnd: (e) => console.log('Turn ended in ms:', e.durationMs),
};
```

---

## 2. Interaction Repository (`InteractionRepository`)

The abstract interface representing durable persistence:

```ts
export interface InteractionRepository {
  createWorkspace<State>(params: ...): Promise<InteractionWorkspaceRecord<State>>;
  loadWorkspace<State>(params: ...): Promise<InteractionWorkspaceRecord<State> | null>;
  commitAction<State>(input: ActionCommitInput<State>): Promise<ActionCommitSuccess<State>>;
  appendMessage(params: ...): Promise<{ message: InteractionMessageRecord; sequence: number; assistantScheduled: boolean }>;
  listMessages(params: ...): Promise<InteractionMessageRecord[]>;
  scheduleRun(params: ...): Promise<InteractionRunRecord>;
  claimRun(params: ...): Promise<InteractionRunRecord | null>;
  heartbeatRun(params: ...): Promise<boolean>;
  completeRun(params: ...): Promise<boolean>;
  failRun(params: ...): Promise<boolean>;
  recordStep(params: ...): Promise<InteractionStepRecord>;
  listSteps(params: { runId: string }): Promise<InteractionStepRecord[]>;
}
```

---

## 3. Assistant Runner Loop (`runAssistantTurn`)

The server-side deliberation runner orchestrates the model turn:

```ts
import { runAssistantTurn } from 'interaction-builder/runtime';
import { createAiSdkModelAdapter } from 'interaction-builder/adapters/ai';

const result = await runAssistantTurn({
  workspaceId,
  ownerId,
  repo,
  domain,
  model: createAiSdkModelAdapter(languageModel),
  createTools: (deps) => createMyDomainTools(deps),
  runId,
  leaseToken,
});
```

### Turn Lifecycle:
1. Validates workspace active lifecycle and observes revision.
2. Formats recent chat transcript (text and entity references).
3. Injects system prompt with live serialized workspace snapshot.
4. Provides tools wrapped with `onToolStep`:
   - Checks if step ordinal was previously completed (replayed from journal).
   - If not completed, records `step: started`.
   - Executes domain commit with `requestId: step:${runId}:${ordinal}` and `runFence`.
   - Records `step: completed` with commit receipt.
5. If an unrecoverable mutation failure occurs (such as `STALE_WORKSPACE`), the runner stops the turn immediately and records `step: failed`.
6. Appends assistant response message and marks model call completed.

---

## 4. Deterministic UUID Generation (`deterministicUuid`)

To ensure retried steps match the exact envelope hash stored in the idempotency ledger (`interaction_requests`):

```ts
import { deterministicUuid } from 'interaction-builder/runtime';

// Returns a valid RFC 4122 v4-formatted UUID generated deterministically from seed string
const actionId = deterministicUuid(`action:${meta.requestId}`);
const entityId = deterministicUuid(`item:${meta.requestId}`);
```
