# Standalone Meeting Agenda Example (Native Interaction-Managed State)

This example demonstrates how to build a production-grade, state-synchronized collaborative application with an embedded AI assistant using exclusively the public exports of `@sidequest/interaction-builder` (or `interaction-builder`).

It is completely decoupled from any specific host domain (e.g. cohorts) and contains zero host aliases or internal framework imports.

---

## Key Capabilities Demonstrated

1. **Native Interaction-Managed State**:
   - Single canonical store mounted via `<InteractionProvider>`.
   - Domain-level pure action planning (`agendaDomain`) validating typed mutations, monotonic revision bumps, and entity-version fencing.

2. **Bidirectional Assistant & User Actions**:
   - **User -> Assistant**: Human edits (e.g. updating meeting title or pinning items) are immediately reflected in the canonical state and visible in assistant turn context.
   - **Assistant -> Workspace**: Assistant tool calls (`set_meeting_title`, `edit_item`, `set_item_pin`, `reorder_items`) directly update workspace state and dispatch real-time events to the UI.

3. **Optimistic Updates & Conflict Rejection**:
   - Client optimistically renders state changes while queuing actions.
   - Stale workspace conflicts (CAS mismatches) are detected server-side and rejected (`STALE_WORKSPACE` / HTTP 409), triggering safe state resynchronization without data corruption.

4. **Durable Persistence vs. Quick-Start**:
   - **PostgreSQL Adapter (`interaction-builder/adapters/pg`)**: Production-ready durability using transactional commits, event sequencing, outbox delivery, and run lease fencing.
   - **Memory Adapter (`interaction-builder/runtime`)**: Zero-dependency in-memory store for instant local testing and fast CI runs.

5. **Deterministic AI Runner**:
   - Operates with zero API keys and zero paid provider calls by default using `createDeterministicAgendaModelAdapter`.

---

## Directory Structure

- `agenda.domain.ts` - Canonical domain schema, typed action definitions, and pure reducer plan (`planAgendaAction`).
- `agenda.tools.ts` - AI tool definitions (`set_meeting_title`, `edit_item`, `set_item_pin`, `reorder_items`) with step journaling.
- `agenda.ui.tsx` - React workspace components (`AgendaViewer`, `AgendaChat`, `AgendaApp`) with history undo/redo toolbar.
- `server.ts` - HTTP API server dispatching standard interaction routes via `dispatchInteraction` from `interaction-builder/adapters/http`.
- `worker.ts` - Background assistant worker claiming runs via `repo.claimRun` and executing deterministic turns.
- `run.ts` - Headless end-to-end simulation script.

---

## Quick Start

### 1. In-Memory Mode (Zero Database Setup)

Start the server with memory storage and embedded worker:
```bash
PORT=3030 DATABASE_URL=memory EMBEDDED_WORKER=true npx tsx examples/agenda/server.ts
```

Check health:
```bash
curl http://localhost:3030/health
# {"status":"ok","storage":"memory"}
```

### 2. Durable PostgreSQL Mode

1. Set up a PostgreSQL database and configure `DATABASE_URL`:
```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/agenda_db"
```
2. Start the server (schema migrations from `migrations/001_interaction_schema.sql` are applied automatically on boot):
```bash
npx tsx examples/agenda/server.ts
```
3. In a separate terminal, start the dedicated background worker (if `EMBEDDED_WORKER` is not set):
```bash
npx tsx examples/agenda/worker.ts
```

---

## API Endpoints Reference

All routes are dispatched through `dispatchInteraction` under `/api/interaction/v1`:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Server health check and storage indicator |
| `POST` | `/api/interaction/v1/workspaces` | Create a new agenda workspace |
| `GET` | `/api/interaction/v1/workspaces/:id` | Fetch current workspace snapshot & revision |
| `POST` | `/api/interaction/v1/workspaces/:id/actions` | Dispatch typed domain action (with CAS expectedRevision) |
| `POST` | `/api/interaction/v1/workspaces/:id/messages` | Append user message with text & entity selection chips |
| `POST` | `/api/interaction/v1/workspaces/:id/run` | Schedule assistant turn execution |
| `GET` | `/api/interaction/v1/workspaces/:id/runs/active` | Get active assistant run details |
| `GET` | `/api/interaction/v1/workspaces/:id/events` | SSE event stream (`text/event-stream`) or JSON catchup |

---

## Clean Shutdown

Both `server.ts` and `worker.ts` handle `SIGINT` (Ctrl+C) and `SIGTERM` gracefully:
- Server stops accepting incoming requests, finishes active in-flight streams, and terminates database pools cleanly.
- Worker yields active lease claims and exits without leaving orphaned run locks.
