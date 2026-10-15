import pg from 'pg';
import type { EntityRef, HostCommandReceipt } from 'interaction-builder/core';
import type { HostAgendaMeeting, HostAgendaItem } from './host-agenda.domain';

export interface HostAgendaRepository {
  getMeeting(ownerId: string, meetingId: string): Promise<HostAgendaMeeting | null>;
  createMeeting(meeting: HostAgendaMeeting): Promise<HostAgendaMeeting>;
  getReceipt(ownerId: string, commandId: string): Promise<HostCommandReceipt | null>;
  executeCommandTransaction(params: {
    ownerId: string;
    meetingId: string;
    expectedVersion: number;
    commandId: string;
    readSet?: EntityRef[];
    mutate: (meeting: HostAgendaMeeting) => { summary: string; changed: EntityRef[] };
  }): Promise<{ receipt: HostCommandReceipt; meeting: HostAgendaMeeting }>;
}

export function createPgHostAgendaRepository(options: { pool: pg.Pool }): HostAgendaRepository {
  const { pool } = options;

  return {
    async getMeeting(ownerId: string, meetingId: string): Promise<HostAgendaMeeting | null> {
      const meetingRes = await pool.query(
        `SELECT "id", "ownerId", "version", "meetingTitle", "date", "createdAt", "updatedAt"
         FROM "host_agenda_meetings"
         WHERE "id" = $1 AND "ownerId" = $2`,
        [meetingId, ownerId]
      );
      if (meetingRes.rows.length === 0) return null;
      const mRow = meetingRes.rows[0];

      const itemsRes = await pool.query(
        `SELECT "id", "version", "title", "durationMinutes", "presenter", "pinned", "sortOrder"
         FROM "host_agenda_items"
         WHERE "meetingId" = $1 AND "ownerId" = $2
         ORDER BY "sortOrder" ASC`,
        [meetingId, ownerId]
      );

      return {
        id: mRow.id,
        ownerId: mRow.ownerId,
        version: Number(mRow.version),
        meetingTitle: mRow.meetingTitle,
        date: mRow.date,
        items: itemsRes.rows.map(r => ({
          id: r.id,
          version: Number(r.version),
          title: r.title,
          durationMinutes: Number(r.durationMinutes),
          presenter: r.presenter,
          pinned: Boolean(r.pinned),
          sortOrder: Number(r.sortOrder),
        })),
        createdAt: new Date(mRow.createdAt).toISOString(),
        updatedAt: new Date(mRow.updatedAt).toISOString(),
      };
    },

    async createMeeting(meeting: HostAgendaMeeting): Promise<HostAgendaMeeting> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO "host_agenda_meetings" ("id", "ownerId", "version", "meetingTitle", "date", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            meeting.id,
            meeting.ownerId,
            meeting.version,
            meeting.meetingTitle,
            meeting.date,
            meeting.createdAt,
            meeting.updatedAt,
          ]
        );

        for (let i = 0; i < meeting.items.length; i++) {
          const item = meeting.items[i];
          await client.query(
            `INSERT INTO "host_agenda_items" ("id", "meetingId", "ownerId", "version", "title", "durationMinutes", "presenter", "pinned", "sortOrder", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              item.id,
              meeting.id,
              meeting.ownerId,
              item.version,
              item.title,
              item.durationMinutes,
              item.presenter,
              item.pinned,
              item.sortOrder,
              meeting.createdAt,
              meeting.updatedAt,
            ]
          );
        }
        await client.query('COMMIT');
        return meeting;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async getReceipt(ownerId: string, commandId: string): Promise<HostCommandReceipt | null> {
      const res = await pool.query(
        `SELECT "receiptId", "commandId", "resourceId", "resultingVersion", "summary", "changed", "committedAt"
         FROM "host_agenda_receipts"
         WHERE "ownerId" = $1 AND "commandId" = $2`,
        [ownerId, commandId]
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      return {
        receiptId: row.receiptId,
        commandId: row.commandId,
        resourceId: row.resourceId,
        resultingVersion: Number(row.resultingVersion),
        summary: row.summary,
        changed: typeof row.changed === 'string' ? JSON.parse(row.changed) : row.changed,
        committedAt: new Date(row.committedAt).toISOString(),
      };
    },

    async executeCommandTransaction(params: {
      ownerId: string;
      meetingId: string;
      expectedVersion: number;
      commandId: string;
      readSet?: EntityRef[];
      mutate: (meeting: HostAgendaMeeting) => { summary: string; changed: EntityRef[] };
    }): Promise<{ receipt: HostCommandReceipt; meeting: HostAgendaMeeting }> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 1. Idempotency Check: Return existing receipt if command was already committed
        const existingReceiptRes = await client.query(
          `SELECT "receiptId", "commandId", "resourceId", "resultingVersion", "summary", "changed", "committedAt"
           FROM "host_agenda_receipts"
           WHERE "ownerId" = $1 AND "commandId" = $2`,
          [params.ownerId, params.commandId]
        );

        if (existingReceiptRes.rows.length > 0) {
          const row = existingReceiptRes.rows[0];
          // Also fetch current meeting for return
          const mRes = await client.query(
            `SELECT "id", "ownerId", "version", "meetingTitle", "date", "createdAt", "updatedAt"
             FROM "host_agenda_meetings" WHERE "id" = $1`,
            [params.meetingId]
          );
          const iRes = await client.query(
            `SELECT "id", "version", "title", "durationMinutes", "presenter", "pinned", "sortOrder"
             FROM "host_agenda_items" WHERE "meetingId" = $1 ORDER BY "sortOrder" ASC`,
            [params.meetingId]
          );
          await client.query('COMMIT');
          return {
            receipt: {
              receiptId: row.receiptId,
              commandId: row.commandId,
              resourceId: row.resourceId,
              resultingVersion: Number(row.resultingVersion),
              summary: row.summary,
              changed: typeof row.changed === 'string' ? JSON.parse(row.changed) : row.changed,
              committedAt: new Date(row.committedAt).toISOString(),
            },
            meeting: {
              id: mRes.rows[0].id,
              ownerId: mRes.rows[0].ownerId,
              version: Number(mRes.rows[0].version),
              meetingTitle: mRes.rows[0].meetingTitle,
              date: mRes.rows[0].date,
              items: iRes.rows.map(r => ({
                id: r.id,
                version: Number(r.version),
                title: r.title,
                durationMinutes: Number(r.durationMinutes),
                presenter: r.presenter,
                pinned: Boolean(r.pinned),
                sortOrder: Number(r.sortOrder),
              })),
              createdAt: new Date(mRes.rows[0].createdAt).toISOString(),
              updatedAt: new Date(mRes.rows[0].updatedAt).toISOString(),
            },
          };
        }

        // 2. Lock meeting row with FOR UPDATE
        const mRowRes = await client.query(
          `SELECT "id", "ownerId", "version", "meetingTitle", "date", "createdAt", "updatedAt"
           FROM "host_agenda_meetings"
           WHERE "id" = $1
           FOR UPDATE`,
          [params.meetingId]
        );

        if (mRowRes.rows.length === 0) {
          throw new Error('UNKNOWN_AGENDA_MEETING: Host meeting not found.');
        }

        const mRow = mRowRes.rows[0];
        if (mRow.ownerId !== params.ownerId) {
          throw new Error('UNAUTHORIZED_OWNER: Access denied to foreign host meeting.');
        }

        const currentVersion = Number(mRow.version);
        if (params.expectedVersion !== currentVersion) {
          throw new Error(
            `STALE_HOST_RESOURCE: Expected version ${params.expectedVersion}, but host resource is at version ${currentVersion}.`
          );
        }

        // Load items for the meeting
        const iRowRes = await client.query(
          `SELECT "id", "version", "title", "durationMinutes", "presenter", "pinned", "sortOrder"
           FROM "host_agenda_items"
           WHERE "meetingId" = $1
           ORDER BY "sortOrder" ASC`,
          [params.meetingId]
        );

        const meeting: HostAgendaMeeting = {
          id: mRow.id,
          ownerId: mRow.ownerId,
          version: currentVersion,
          meetingTitle: mRow.meetingTitle,
          date: mRow.date,
          items: iRowRes.rows.map(r => ({
            id: r.id,
            version: Number(r.version),
            title: r.title,
            durationMinutes: Number(r.durationMinutes),
            presenter: r.presenter,
            pinned: Boolean(r.pinned),
            sortOrder: Number(r.sortOrder),
          })),
          createdAt: new Date(mRow.createdAt).toISOString(),
          updatedAt: new Date(mRow.updatedAt).toISOString(),
        };

        // 3. Verify readSet if provided
        if (params.readSet && params.readSet.length > 0) {
          const itemMap = new Map(meeting.items.map(i => [i.id, i.version]));
          for (const ref of params.readSet) {
            if (ref.kind === 'agenda_item') {
              const currentItemVersion = itemMap.get(ref.id);
              if (currentItemVersion === undefined || currentItemVersion !== ref.version) {
                throw new Error(
                  `STALE_ENTITY: Read set conflict on item ${ref.id} (expected ${ref.version}, found ${currentItemVersion}).`
                );
              }
            } else if (ref.kind === 'host_agenda_meeting' && ref.id === meeting.id) {
              if (ref.version !== currentVersion) {
                throw new Error(
                  `STALE_HOST_RESOURCE: Read set conflict on meeting ${ref.id} (expected ${ref.version}, found ${currentVersion}).`
                );
              }
            }
          }
        }

        // 4. Apply domain mutation
        const { summary, changed } = params.mutate(meeting);
        const nextVersion = currentVersion + 1;
        meeting.version = nextVersion;
        meeting.updatedAt = new Date().toISOString();

        // 5. Update database records
        await client.query(
          `UPDATE "host_agenda_meetings"
           SET "version" = $1, "meetingTitle" = $2, "updatedAt" = $3
           WHERE "id" = $4`,
          [nextVersion, meeting.meetingTitle, meeting.updatedAt, meeting.id]
        );

        for (const item of meeting.items) {
          await client.query(
            `UPDATE "host_agenda_items"
             SET "version" = $1, "title" = $2, "durationMinutes" = $3, "pinned" = $4, "sortOrder" = $5, "updatedAt" = $6
             WHERE "id" = $7 AND "meetingId" = $8`,
            [
              item.version,
              item.title,
              item.durationMinutes,
              item.pinned,
              item.sortOrder,
              meeting.updatedAt,
              item.id,
              meeting.id,
            ]
          );
        }

        // 6. Record receipt in host_agenda_receipts
        const receiptId = crypto.randomUUID();
        const receipt: HostCommandReceipt = {
          receiptId,
          commandId: params.commandId,
          resourceId: meeting.id,
          resultingVersion: nextVersion,
          summary,
          changed,
          committedAt: meeting.updatedAt,
        };

        await client.query(
          `INSERT INTO "host_agenda_receipts" ("receiptId", "commandId", "ownerId", "resourceId", "resultingVersion", "summary", "changed", "committedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            receipt.receiptId,
            receipt.commandId,
            params.ownerId,
            receipt.resourceId,
            receipt.resultingVersion,
            receipt.summary,
            JSON.stringify(receipt.changed),
            receipt.committedAt,
          ]
        );

        await client.query('COMMIT');
        return { receipt, meeting };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export function createMemoryHostAgendaRepository(): HostAgendaRepository {
  const meetings = new Map<string, HostAgendaMeeting>();
  const receipts = new Map<string, HostCommandReceipt>();

  const receiptKey = (ownerId: string, cmdId: string) => `${ownerId}:${cmdId}`;
  const meetingKey = (ownerId: string, meetingId: string) => `${ownerId}:${meetingId}`;

  return {
    async getMeeting(ownerId: string, meetingId: string): Promise<HostAgendaMeeting | null> {
      const m = meetings.get(meetingKey(ownerId, meetingId));
      return m ? structuredClone(m) : null;
    },

    async createMeeting(meeting: HostAgendaMeeting): Promise<HostAgendaMeeting> {
      const copy = structuredClone(meeting);
      meetings.set(meetingKey(meeting.ownerId, meeting.id), copy);
      return copy;
    },

    async getReceipt(ownerId: string, commandId: string): Promise<HostCommandReceipt | null> {
      const r = receipts.get(receiptKey(ownerId, commandId));
      return r ? structuredClone(r) : null;
    },

    async executeCommandTransaction(params: {
      ownerId: string;
      meetingId: string;
      expectedVersion: number;
      commandId: string;
      readSet?: EntityRef[];
      mutate: (meeting: HostAgendaMeeting) => { summary: string; changed: EntityRef[] };
    }): Promise<{ receipt: HostCommandReceipt; meeting: HostAgendaMeeting }> {
      // 1. Idempotency check
      const rKey = receiptKey(params.ownerId, params.commandId);
      const existing = receipts.get(rKey);
      if (existing) {
        const m = meetings.get(meetingKey(params.ownerId, params.meetingId))!;
        return { receipt: structuredClone(existing), meeting: structuredClone(m) };
      }

      // 2. Fetch and check ownership
      const m = meetings.get(meetingKey(params.ownerId, params.meetingId));
      if (!m) {
        // Check if meeting exists under another owner
        for (const [key, item] of meetings.entries()) {
          if (item.id === params.meetingId && item.ownerId !== params.ownerId) {
            throw new Error('UNAUTHORIZED_OWNER: Access denied to foreign host meeting.');
          }
        }
        throw new Error('UNKNOWN_AGENDA_MEETING: Host meeting not found.');
      }

      // 3. Expected version check
      if (params.expectedVersion !== m.version) {
        throw new Error(
          `STALE_HOST_RESOURCE: Expected version ${params.expectedVersion}, but host resource is at version ${m.version}.`
        );
      }

      // 4. Verify readSet if provided
      if (params.readSet && params.readSet.length > 0) {
        const itemMap = new Map(m.items.map(i => [i.id, i.version]));
        for (const ref of params.readSet) {
          if (ref.kind === 'agenda_item') {
            const currentItemVersion = itemMap.get(ref.id);
            if (currentItemVersion === undefined || currentItemVersion !== ref.version) {
              throw new Error(
                `STALE_ENTITY: Read set conflict on item ${ref.id} (expected ${ref.version}, found ${currentItemVersion}).`
              );
            }
          } else if (ref.kind === 'host_agenda_meeting' && ref.id === m.id) {
            if (ref.version !== m.version) {
              throw new Error(
                `STALE_HOST_RESOURCE: Read set conflict on meeting ${ref.id} (expected ${ref.version}, found ${m.version}).`
              );
            }
          }
        }
      }

      // 5. Apply domain mutation
      const meeting = structuredClone(m);
      const { summary, changed } = params.mutate(meeting);
      const nextVersion = meeting.version + 1;
      meeting.version = nextVersion;
      meeting.updatedAt = new Date().toISOString();

      // 6. Record receipt
      const receipt: HostCommandReceipt = {
        receiptId: crypto.randomUUID(),
        commandId: params.commandId,
        resourceId: meeting.id,
        resultingVersion: nextVersion,
        summary,
        changed,
        committedAt: meeting.updatedAt,
      };

      meetings.set(meetingKey(params.ownerId, params.meetingId), meeting);
      receipts.set(rKey, receipt);

      return { receipt, meeting };
    },
  };
}
