-- Host-Owned Business Resource Schema: Agenda Meetings, Items & Command Receipts
BEGIN;

CREATE TABLE IF NOT EXISTS "host_agenda_meetings" (
  "id" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "meetingTitle" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "host_agenda_meetings_version_check" CHECK ("version" >= 0)
);
CREATE INDEX IF NOT EXISTS "idx_host_agenda_meetings_owner" ON "host_agenda_meetings"("ownerId");

CREATE TABLE IF NOT EXISTS "host_agenda_items" (
  "id" TEXT PRIMARY KEY,
  "meetingId" TEXT NOT NULL REFERENCES "host_agenda_meetings"("id") ON DELETE CASCADE,
  "ownerId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "title" TEXT NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "presenter" TEXT NOT NULL,
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "host_agenda_items_version_check" CHECK ("version" >= 0),
  CONSTRAINT "host_agenda_items_duration_check" CHECK ("durationMinutes" > 0)
);
CREATE INDEX IF NOT EXISTS "idx_host_agenda_items_meeting" ON "host_agenda_items"("meetingId", "sortOrder");

CREATE TABLE IF NOT EXISTS "host_agenda_receipts" (
  "receiptId" TEXT PRIMARY KEY,
  "commandId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL REFERENCES "host_agenda_meetings"("id") ON DELETE CASCADE,
  "resultingVersion" INTEGER NOT NULL,
  "summary" TEXT NOT NULL,
  "changed" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "uq_host_agenda_receipts_owner_command" UNIQUE ("ownerId", "commandId")
);
CREATE INDEX IF NOT EXISTS "idx_host_agenda_receipts_resource" ON "host_agenda_receipts"("resourceId");

COMMIT;
