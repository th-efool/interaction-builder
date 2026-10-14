import { describe, expect, it } from 'vitest';
import { createSqliteInteractionRepository, type SqliteDriver } from '../src/adapters/sqlite';

function createMockSqliteDriver(): SqliteDriver {
  const tables = new Map<string, any[]>();

  const getTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  return {
    exec: () => {},
    query: async (sql, params = []) => {
      if (sql.includes('INSERT INTO interaction_workspaces')) {
        getTable('workspaces').push({
          id: params[0],
          ownerId: params[1],
          domainId: params[2],
          domainVersion: params[3],
          snapshot: params[4],
          revision: 0,
          contextEpoch: 0,
          sequence: 0,
          lifecycle: 'active',
          createdAt: params[5],
          updatedAt: params[6],
        });
        return [];
      }
      if (sql.includes('SELECT * FROM interaction_workspaces WHERE id = ? AND ownerId = ?')) {
        return getTable('workspaces').filter(w => w.id === params[0] && w.ownerId === params[1]);
      }
      if (sql.includes('SELECT * FROM interaction_workspaces WHERE id = ?')) {
        return getTable('workspaces').filter(w => w.id === params[0]);
      }
      if (sql.includes('UPDATE interaction_workspaces SET snapshot = ?, revision = ?, contextEpoch = contextEpoch + 1, sequence = ?, updatedAt = ? WHERE id = ?')) {
        const ws = getTable('workspaces').find(w => w.id === params[4]);
        if (ws) {
          ws.snapshot = params[0];
          ws.revision = params[1];
          ws.sequence = params[2];
          ws.updatedAt = params[3];
          ws.contextEpoch += 1;
        }
        return [];
      }
      if (sql.includes('SELECT * FROM interaction_messages WHERE id = ?')) {
        return getTable('messages').filter(m => m.id === params[0]);
      }
      if (sql.includes('INSERT INTO interaction_messages')) {
        getTable('messages').push({
          id: params[0],
          workspaceId: params[1],
          role: params[2],
          parts: params[3],
          sequence: params[4],
          runId: params[5],
          createdAt: params[6],
        });
        return [];
      }
      if (sql.includes('SELECT sequence, contextEpoch, revision FROM interaction_workspaces')) {
        return getTable('workspaces').filter(w => w.id === params[0] && w.ownerId === params[1]);
      }
      if (sql.includes('UPDATE interaction_workspaces SET sequence = ?, updatedAt = ? WHERE id = ?')) {
        const ws = getTable('workspaces').find(w => w.id === params[2]);
        if (ws) {
          ws.sequence = params[0];
          ws.updatedAt = params[1];
        }
        return [];
      }
      if (sql.includes('SELECT * FROM interaction_runs WHERE id = ?')) {
        return getTable('runs').filter(r => r.id === params[0]);
      }
      if (sql.includes('SELECT * FROM interaction_runs WHERE workspaceId = ?')) {
        return getTable('runs').filter(r => r.workspaceId === params[0]);
      }
      if (sql.includes('INSERT INTO interaction_runs')) {
        getTable('runs').push({
          id: params[0],
          workspaceId: params[1],
          triggeringMessageId: params[2],
          status: 'queued',
          contextEpoch: params[3],
          observedRevision: params[4],
          cursor: params[5],
          fence: 0,
          leaseOwner: null,
          leaseToken: null,
          leaseUntil: null,
          createdAt: params[6],
          updatedAt: params[6],
        });
        return [];
      }
      if (sql.includes('UPDATE interaction_runs SET status = ?')) {
        const run = getTable('runs').find(r => r.id === params[1] || r.id === params[params.length - 1]);
        if (run) {
          run.status = params[0];
        }
        return [];
      }
      if (sql.includes('INSERT INTO interaction_events')) {
        getTable('events').push({
          id: params[0],
          workspaceId: params[1],
          sequence: params[2],
          protocolVersion: 1,
          type: params[3] ?? 'workspace.committed',
          revision: params[4],
          payload: params[5],
          createdAt: params[6],
        });
        return [];
      }
      if (sql.includes('INSERT OR IGNORE INTO interaction_outbox')) {
        getTable('outbox').push({
          id: params[0],
          workspaceId: params[1],
          kind: params[2],
          payload: params[3],
          dedupKey: params[4],
          status: 'pending',
          attempts: 0,
          dueAt: params[5],
        });
        return [];
      }
      if (sql.includes('SELECT sequence FROM interaction_workspaces WHERE id = ?')) {
        const ws = getTable('workspaces').find(w => w.id === params[0]);
        return ws ? [{ sequence: ws.sequence }] : [];
      }
      if (sql.includes('UPDATE interaction_workspaces SET sequence = ?')) {
        const ws = getTable('workspaces').find(w => w.id === params[2]);
        if (ws) {
          ws.sequence = params[0];
          ws.updatedAt = params[1];
        }
        return [];
      }
      return [];
    },
    transaction: fn => fn(),
  };
}

describe('Universal SQLite / LibSQL Adapter', () => {
  it('creates workspace and executes transactional action commits with outbox', async () => {
    const driver = createMockSqliteDriver();
    const repo = createSqliteInteractionRepository(driver);

    const workspaceId = '550e8400-e29b-41d4-a716-446655440001';
    const ws = await repo.createWorkspace({
      id: workspaceId,
      ownerId: 'user-1',
      domainId: 'agenda',
      domainVersion: 1,
      initialSnapshot: { title: 'SQLite Agenda', count: 0 },
    });

    expect(ws.id).toBe(workspaceId);
    expect(ws.revision).toBe(0);

    const commitRes = await repo.commitAction({
      workspaceId,
      ownerId: 'user-1',
      expectedRevision: 0,
      envelope: {
        actionId: '550e8400-e29b-41d4-a716-446655440099',
        workspaceId,
        expectedRevision: 0,
        entityVersions: [],
        action: { type: 'inc' },
      },
      outboxItems: [
        { kind: 'notify', payload: { text: 'Counter incremented' }, dedupKey: 'dedup-1' },
      ],
      plan: (state: any) => ({
        nextState: { ...state, count: state.count + 1 },
        changed: [],
        invalidated: [],
        summary: 'Incremented count',
        undoable: true,
      }),
    });

    expect(commitRes.revision).toBe(1);
    expect(commitRes.state.count).toBe(1);
    expect(commitRes.sequence).toBe(1);

    // Recheck loadWorkspace
    const reloaded = await repo.loadWorkspace<{ title: string; count: number }>({
      workspaceId,
      ownerId: 'user-1',
    });
    expect(reloaded).not.toBeNull();
    expect(reloaded?.revision).toBe(1);
    expect(reloaded?.snapshot.count).toBe(1);
  });

  it('rejects commits with expired or non-existent run fences', async () => {
    const driver = createMockSqliteDriver();
    const repo = createSqliteInteractionRepository(driver);
    const workspaceId = '550e8400-e29b-41d4-a716-446655440002';

    await repo.createWorkspace({
      id: workspaceId,
      ownerId: 'user-1',
      domainId: 'agenda',
      domainVersion: 1,
      initialSnapshot: { title: 'Fenced Agenda', count: 0 },
    });

    // Attempt commit with a non-existent runId fence
    await expect(
      repo.commitAction({
        workspaceId,
        ownerId: 'user-1',
        expectedRevision: 0,
        runFence: { runId: 'missing-run', leaseToken: 'tok-1' },
        envelope: {
          actionId: '550e8400-e29b-41d4-a716-446655440098',
          workspaceId,
          expectedRevision: 0,
          entityVersions: [],
          action: { type: 'inc' },
        },
        plan: (state: any) => ({
          nextState: { ...state, count: state.count + 1 },
          changed: [],
          invalidated: [],
          summary: 'Should fail',
          undoable: true,
        }),
      })
    ).rejects.toThrow('RUN_CANCELED');
  });
});
