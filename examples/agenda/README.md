# Standalone Meeting Agenda Example (Native Interaction-Managed State)

This example demonstrates how to build a production-grade, state-synchronized collaborative application with an embedded AI assistant using exclusively the public exports of `@sidequest/interaction-builder` (or `interaction-builder`).

It is completely decoupled from any specific host domain (e.g. cohorts) and contains zero host aliases or internal framework imports.

---

## Two Integration Profiles Demonstrated

### Profile 1: Native Interaction-Managed State
- **Single Canonical Store**: The interaction builder's `interaction_workspaces` table owns the domain state.
- **Pure Action Planning**: Mutations are defined by `DomainDefinition.plan` (`agendaDomain`), bumping monotonic revisions and updating the snapshot.
- **Full History**: Supports client-side undo/redo and time-travel over historical snapshots.

### Profile 2: Host-Owned Business Resource Profile
- **Authoritative Business Authority**: The host application's existing database (e.g. `host_agenda_meetings` and `host_agenda_items`) remains the **sole source of truth**.
- **No Dual Writers & No Competing Snapshots**: The interaction workspace stores **only interaction metadata** (`meetingId`, `observedVersion`, `selectedItemId`). It stores **zero duplicate business data**.
- **Single Command Boundary (`HostAgendaService.executeCommand`)**: Both direct human UI operations and assistant tool executions call the exact same authorized host command boundary.
- **CAS & Read-Set Fencing**: Commands specify `expectedVersion`. Stale model commands or concurrent client edits are rejected with `STALE_HOST_RESOURCE` (HTTP 409 `CONFLICT`) rather than silently overwriting.
- **Idempotency & Replay Resilience**: Commands specify `commandId`. Retried requests return the cached receipt from `host_agenda_receipts` without duplicating mutations.
- **Zero Phantom Reversals**: Turn cancellation halts subsequent steps but never falsely undos committed host effects.

---

## Directory Structure

- `agenda.domain.ts` - Native domain schema, typed action definitions, and pure reducer plan (`planAgendaAction`).
- `agenda.tools.ts` - Native AI tool definitions with step journaling.
- `agenda.ui.tsx` - Native React workspace components (`AgendaViewer`, `AgendaChat`, `AgendaApp`).
- `host-agenda.domain.ts` - Host-owned business records schema (`HostAgendaMeeting`), typed host commands, and lightweight binding workspace.
- `host-agenda.repository.ts` - Authoritative host repository (PostgreSQL `host_agenda_*` tables & in-memory store) with `SELECT ... FOR UPDATE` locking.
- `host-agenda.service.ts` - Authorized host command boundary enforcing CAS, read-set checks, and idempotent receipts.
- `host-agenda.tools.ts` - AI tool definitions bridging assistant turns directly to `HostAgendaService.executeCommand`.
- `host-agenda.worker.ts` - Dedicated worker for host-owned agendas.
- `host-agenda.ui.tsx` - React UI combining direct host commands and interaction-managed chat.
- `server.ts` - Unified HTTP server supporting both native workspaces and host-owned business resources.
- `worker.ts` - Unified background worker handling both native and host-owned domain runs.
- `host-schema.sql` - SQL schema for host-owned tables (`host_agenda_meetings`, `host_agenda_items`, `host_agenda_receipts`).

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
2. Start the server (engine and host migrations applied automatically on boot):
```bash
npx tsx examples/agenda/server.ts
```

---

## API Endpoints Reference

### 1. Host-Owned Business Resource Endpoints
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/host/meetings` | Create new authoritative host meeting |
| `GET` | `/api/host/meetings/:id` | Read authoritative host meeting state |
| `POST` | `/api/host/meetings/:id/commands` | Execute authorized typed command (with expectedVersion & Idempotency-Key) |

### 2. Interaction Builder Orchestration Endpoints (`/api/interaction/v1`)
| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Server health check and storage indicator |
| `POST` | `/api/interaction/v1/workspaces` | Create a new agenda workspace (native or host-bound) |
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
