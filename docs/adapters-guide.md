# Adapters Guide

Interaction Builder uses a decoupled adapter architecture to remain independent of specific web frameworks, ORMs, or AI model providers.

---

## 1. PostgreSQL Adapter (`interaction-builder/adapters/pg`)

A pure, high-performance PostgreSQL driver implementation with zero Prisma or ORM dependencies, built directly on `pg.Pool`.

### Setup
```ts
import { createPgInteractionRepository } from 'interaction-builder/adapters/pg';

// From connection string
const repo = createPgInteractionRepository({
  connectionString: process.env.DATABASE_URL,
});

// Or from existing pg.Pool
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const repo = createPgInteractionRepository({ pool });
```

### Supported Features
- ESM compatible in Node.js 18, 20, 22, 24+.
- Row locking with `FOR UPDATE SKIP LOCKED` for worker lease acquisition.
- Token-based fence verification on mutations.
- Monotonic revision check in single database transaction.

---

## 2. AI SDK Model Adapter (`interaction-builder/adapters/ai`)

Bridges Vercel's AI SDK (`ai`) to the provider-agnostic `InteractionModelAdapter` interface used by the generic runner.

### Setup
```ts
import { createAiSdkModelAdapter } from 'interaction-builder/adapters/ai';
import { google } from '@ai-sdk/google'; // or openai, anthropic, etc.

const modelAdapter = createAiSdkModelAdapter(
  google('gemini-2.5-flash')
);
```

### Safety Features
- **Fatal Error Boundary**: When a domain mutation tool throws (e.g. `STALE_WORKSPACE` due to an intervening user edit), the adapter halts subsequent model generation steps via an `AbortController` signal and rethrows the fatal error to abort the turn cleanly.
- Compatible with mock test models (`MockLanguageModelV4` from `ai/test`).

---

## 3. Web HTTP Adapter (`interaction-builder/adapters/http`)

Dispatches REST API endpoints using standard Web `Request` and `Response` objects. Compatible with Next.js App Router, Cloudflare Workers, Express (with fetch adapter), and Fastify.

### Setup (Next.js Route Handler)
```ts
// src/app/api/interaction/v1/[...segments]/route.ts
import { dispatchInteraction } from 'interaction-builder/adapters/http';
import { createInteractionHandlers } from 'interaction-builder/runtime';

export async function GET(req: Request, { params }: { params: { segments: string[] } }) {
  return dispatchInteraction(req, params.segments, getUserId, handlers);
}

export async function POST(req: Request, { params }: { params: { segments: string[] } }) {
  return dispatchInteraction(req, params.segments, getUserId, handlers);
}
```

### Endpoints Handled:
- `POST /api/interaction/v1/workspaces`: Create workspace
- `GET /api/interaction/v1/workspaces/:id`: Load workspace snapshot & revision
- `POST /api/interaction/v1/workspaces/:id/actions`: Commit action envelope
- `POST /api/interaction/v1/workspaces/:id/messages`: Append chat message
- `GET /api/interaction/v1/workspaces/:id/messages`: List transcript messages
- `GET /api/interaction/v1/workspaces/:id/events`: Server-Sent Events (SSE) stream
- `POST /api/interaction/v1/workspaces/:id/proposals`: Create/resolve proposals
