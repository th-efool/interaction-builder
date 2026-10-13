-- Interaction Builder - 001 Schema Migration
-- Creates the 8 interaction engine tables, constraints, and indexes.

BEGIN;

-- 1. interaction_workspaces
CREATE TABLE IF NOT EXISTS "interaction_workspaces" (
  "id" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "domainId" TEXT NOT NULL,
  "domainVersion" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "contextEpoch" INTEGER NOT NULL DEFAULT 0,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "lifecycle" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "interaction_workspaces_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "interaction_workspaces_sequence_check" CHECK ("sequence" >= 0),
  CONSTRAINT "interaction_workspaces_lifecycle_check" CHECK ("lifecycle" IN ('active','paused','released','archived'))
);
CREATE INDEX IF NOT EXISTS "interaction_workspaces_ownerId_updatedAt_idx" ON "interaction_workspaces"("ownerId", "updatedAt");
CREATE INDEX IF NOT EXISTS "interaction_workspaces_domainId_lifecycle_idx" ON "interaction_workspaces"("domainId", "lifecycle");

-- 2. interaction_requests
CREATE TABLE IF NOT EXISTS "interaction_requests" (
  "id" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "interaction_workspaces"("id") ON DELETE CASCADE,
  "actorId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interaction_requests_workspace_actor_operation_request_key" UNIQUE("workspaceId","actorId","operation","requestId")
);
CREATE INDEX IF NOT EXISTS "interaction_requests_createdAt_idx" ON "interaction_requests"("createdAt");

-- 3. interaction_events
CREATE TABLE IF NOT EXISTS "interaction_events" (
  "id" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "interaction_workspaces"("id") ON DELETE CASCADE,
  "sequence" INTEGER NOT NULL,
  "protocolVersion" INTEGER NOT NULL DEFAULT 1,
  "type" TEXT NOT NULL,
  "revision" INTEGER,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interaction_events_workspaceId_sequence_key" UNIQUE("workspaceId","sequence"),
  CONSTRAINT "interaction_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "interaction_events_protocol_check" CHECK ("protocolVersion" = 1)
);
CREATE INDEX IF NOT EXISTS "interaction_events_createdAt_idx" ON "interaction_events"("createdAt");

-- 4. interaction_outbox
CREATE TABLE IF NOT EXISTS "interaction_outbox" (
  "id" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "interaction_workspaces"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "dedupKey" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "interaction_outbox_status_check" CHECK ("status" IN ('pending','delivering','delivered','failed')),
  CONSTRAINT "interaction_outbox_attempts_check" CHECK ("attempts" >= 0)
);
CREATE INDEX IF NOT EXISTS "interaction_outbox_status_dueAt_leaseUntil_idx" ON "interaction_outbox"("status","dueAt","leaseUntil");

-- 5. interaction_messages
CREATE TABLE IF NOT EXISTS "interaction_messages" (
  "id" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "interaction_workspaces"("id") ON DELETE CASCADE,
  "role" TEXT NOT NULL,
  "parts" JSONB NOT NULL,
  "sequence" INTEGER NOT NULL,
  "runId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "interaction_messages_workspaceId_sequence_key" UNIQUE("workspaceId","sequence"),
  CONSTRAINT "interaction_messages_role_check" CHECK ("role" IN ('user','assistant','system')),
  CONSTRAINT "interaction_messages_sequence_check" CHECK ("sequence" > 0)
);

-- 6. interaction_runs
CREATE TABLE IF NOT EXISTS "interaction_runs" (
  "id" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "interaction_workspaces"("id") ON DELETE CASCADE,
  "triggeringMessageId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "contextEpoch" INTEGER NOT NULL DEFAULT 0,
  "observedRevision" INTEGER NOT NULL DEFAULT 0,
  "cursor" INTEGER NOT NULL DEFAULT 0,
  "fence" INTEGER NOT NULL DEFAULT 0,
  "leaseOwner" TEXT,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMPTZ,
  "deadline" TIMESTAMPTZ,
  "budgetReservation" JSONB,
  "budgetActual" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "interaction_runs_workspaceId_status_idx" ON "interaction_runs"("workspaceId", "status");
CREATE INDEX IF NOT EXISTS "interaction_runs_status_leaseUntil_idx" ON "interaction_runs"("status", "leaseUntil");
CREATE UNIQUE INDEX IF NOT EXISTS "interaction_runs_active_unique_idx" ON "interaction_runs"("workspaceId") WHERE "status" IN ('queued', 'running');

-- 7. interaction_steps
CREATE TABLE IF NOT EXISTS "interaction_steps" (
  "id" TEXT PRIMARY KEY,
  "runId" TEXT NOT NULL REFERENCES "interaction_runs"("id") ON DELETE CASCADE,
  "ordinal" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "toolName" TEXT,
  "inputHash" TEXT,
  "inputPayload" JSONB,
  "state" TEXT NOT NULL DEFAULT 'started',
  "result" JSONB,
  "error" TEXT,
  "effectKey" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "interaction_steps_runId_ordinal_key" UNIQUE ("runId", "ordinal")
);
CREATE INDEX IF NOT EXISTS "interaction_steps_runId_toolName_inputHash_idx" ON "interaction_steps"("runId", "toolName", "inputHash");

-- 8. interaction_proposals
CREATE TABLE IF NOT EXISTS "interaction_proposals" (
  "id" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "interaction_workspaces"("id") ON DELETE CASCADE,
  "actionPayload" JSONB NOT NULL,
  "readSet" JSONB,
  "summary" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" TIMESTAMPTZ,
  "decisionActor" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "interaction_proposals_workspaceId_state_idx" ON "interaction_proposals"("workspaceId", "state");

COMMIT;
