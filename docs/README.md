# Interaction Builder Documentation

Welcome to the comprehensive documentation for **Interaction Builder** — the deterministic conversational interaction engine designed for robust, transactional human-AI collaboration on complex business objects.

---

## Table of Contents

### 1. [Quickstart Guide](./quickstart.md)
Get up and running in under 5 minutes. Learn how to install the package, define a domain, configure the PostgreSQL storage adapter, set up the assistant runner, and render the interactive React UI.

### 2. [Architecture & Durability Engine](./architecture.md)
Understand why probabilistic LLMs require deterministic transactional persistence. Explore:
- The 3-Layer separation of concerns
- Monotonic revision tracking and sequence numbers
- Atomic outbox intent pattern
- Worker leases and token fencing (`FOR UPDATE SKIP LOCKED`)
- Durable step journaling and crash replay recovery
- Idempotent request hashing and deterministic UUID generation

### 3. [Core Contracts & Schemas](./core-contracts.md)
Comprehensive reference for browser-safe domain interfaces:
- Action envelopes (`ActionEnvelope`)
- Change receipts (`ChangeReceipt`) and entity references (`EntityRef`)
- Interaction events (`InteractionEvent`)
- Optimistic state reducer (`interactionReducer`)

### 4. [Runtime Orchestration & Execution](./runtime-guide.md)
Deep dive into server-side execution:
- Pure domain action planning (`planActionCommit`)
- Domain interaction handlers (`createInteractionHandlers`)
- Assistant runner loop (`runAssistantTurn`)
- Step journaling lifecycle (`started`, `completed`, `failed`)
- Replay recovery and deduplication
- Deterministic UUID derivation (`deterministicUuid`)

### 5. [React & Client Store](./react-and-client.md)
Build responsive, optimistic frontends:
- `<InteractionProvider>` configuration
- Typed workspace hooks:
  - `useWorkspaceView<T>()`
  - `useWorkspaceRevision()`
  - `useWorkspaceMessages()`
  - `useDispatchAction<A>()`
  - `useSendMessage()`
  - `usePendingActions()`
  - `useInteractionStream()`
- HTTP transport and Server-Sent Events (SSE) streaming

### 6. [Adapters Guide](./adapters-guide.md)
Connect to databases, web frameworks, and AI models:
- **PostgreSQL (`interaction-builder/adapters/pg`)**: Pure `pg.Pool` driver, 8-table schema migration, connection pools
- **AI SDK (`interaction-builder/adapters/ai`)**: `createAiSdkModelAdapter`, tool execution error boundaries, and generation abort signaling
- **HTTP (`interaction-builder/adapters/http`)**: Standard Web Fetch `Request` / `Response` dispatcher for Next.js App Router, Express, or Fastify

### 7. [Custom Domain Walkthrough](./custom-domain-example.md)
A complete, real-world tutorial demonstrating how to build an independent Meeting Agenda workspace with conversational AI tools, manual UI actions, optimistic updates, and conflict resolution.

### 8. [Testing Guide](./testing-guide.md)
How to write rock-solid tests without hitting production databases or external LLM APIs:
- In-memory repository (`MemoryInteractionRepository`)
- Scripted mock language models (`createScriptedModelAdapter`)
- Headless DOM component tests with jsdom and `@testing-library/react`
- Architectural boundary enforcement tests
