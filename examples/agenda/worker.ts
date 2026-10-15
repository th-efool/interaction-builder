import pg from 'pg';
import { runAssistantTurn, type InteractionRepository } from 'interaction-builder/runtime';
import { createPgInteractionRepository } from 'interaction-builder/adapters/pg';
import { createMemoryInteractionRepository } from 'interaction-builder/runtime';
import { agendaDomain, type AgendaWorkspace } from './agenda.domain';
import { createAgendaAiTools } from './agenda.tools';
import type {
  InteractionModelAdapter,
  InteractionModelTurnInput,
  InteractionModelTurnOutput,
} from 'interaction-builder/runtime';

const PgPool = (pg as any)?.Pool ?? (pg as any)?.default?.Pool ?? pg.Pool;

/**
 * Deterministic model adapter that parses user instructions without any external API calls.
 */
export function createDeterministicAgendaModelAdapter(): InteractionModelAdapter {
  return {
    async executeTurn(input: InteractionModelTurnInput): Promise<InteractionModelTurnOutput> {
      let stepsCount = 0;
      const lastUserMsg = [...input.messages].reverse().find(m => m.role === 'user');
      const text = lastUserMsg?.content.toLowerCase() ?? '';

      // 1. Rename / Title action
      if (text.includes('rename') || text.includes('title')) {
        const match = lastUserMsg?.content.match(/["']([^"']+)["']/);
        const newTitle = match ? match[1] : 'Executive Strategy Review';
        if (input.tools.set_meeting_title) {
          await input.tools.set_meeting_title.execute({ title: newTitle });
          stepsCount += 1;
        }
      }

      // 2. Pin / Unpin action
      if (text.includes('unpin')) {
        if (input.tools.set_item_pin) {
          await input.tools.set_item_pin.execute({ itemId: 'item-1', pinned: false });
          stepsCount += 1;
        }
      } else if (text.includes('pin')) {
        if (input.tools.set_item_pin) {
          await input.tools.set_item_pin.execute({ itemId: 'item-1', pinned: true });
          stepsCount += 1;
        }
      }

      // 3. Duration edits
      if (text.includes('duration') || text.includes('minutes') || text.includes('longer') || text.includes('shorter')) {
        const numMatch = text.match(/\b(\d+)\s*(min|minute|m)?\b/);
        const durationMinutes = numMatch ? parseInt(numMatch[1], 10) : 45;
        if (input.tools.edit_item) {
          await input.tools.edit_item.execute({ itemId: 'item-1', durationMinutes });
          stepsCount += 1;
        }
      }

      // 4. Reorder items
      if (text.includes('reorder') || text.includes('swap') || text.includes('reverse')) {
        if (input.tools.reorder_items) {
          await input.tools.reorder_items.execute({ itemIds: ['item-2', 'item-1'] });
          stepsCount += 1;
        }
      }

      const responseText = stepsCount > 0
        ? `I have processed your request and applied ${stepsCount} agenda modification(s).`
        : 'I have reviewed your message. You can instruct me to rename the meeting, adjust item durations, pin items, or reorder the agenda.';

      return {
        text: responseText,
        stepsCount: Math.max(1, stepsCount),
      };
    },
  };
}

export interface WorkerOptions {
  repo: InteractionRepository;
  pollIntervalMs?: number;
  workerId?: string;
  leaseDurationMs?: number;
  pool?: pg.Pool;
  defaultOwnerId?: string;
}

export function startAgendaWorker(options: WorkerOptions) {
  const {
    repo,
    pollIntervalMs = 250,
    workerId = `agenda-worker-${crypto.randomUUID().slice(0, 8)}`,
    leaseDurationMs = 30_000,
  } = options;

  let running = true;
  let currentPromise: Promise<void> | null = null;
  const model = createDeterministicAgendaModelAdapter();

  const loop = async () => {
    while (running) {
      try {
        const leaseToken = crypto.randomUUID();
        const claimed = await repo.claimRun({
          leaseOwner: workerId,
          leaseToken,
          leaseDurationMs,
        });

        if (claimed) {
          try {
            let ownerId = options.defaultOwnerId ?? 'agenda-user-default';
            if (options.pool) {
              try {
                const r = await options.pool.query(
                  'SELECT "ownerId" FROM "interaction_workspaces" WHERE "id" = $1',
                  [claimed.workspaceId]
                );
                if (r.rows[0]?.ownerId) {
                  ownerId = r.rows[0].ownerId;
                }
              } catch {}
            } else if ((repo as any).workspaces?.get) {
              const ws = (repo as any).workspaces.get(claimed.workspaceId);
              if (ws?.ownerId) {
                ownerId = ws.ownerId;
              }
            }

            const res = await runAssistantTurn({
              workspaceId: claimed.workspaceId,
              ownerId,
              repo,
              domain: agendaDomain,
              model,
              createTools: createAgendaAiTools,
              runId: claimed.id,
              leaseToken,
            });

            await repo.completeRun({
              runId: claimed.id,
              leaseToken,
              assistantMessageId: res.assistantMessageId,
            });
          } catch (turnErr) {
            console.error(`[worker ${workerId}] Turn failed for run ${claimed.id}:`, turnErr);
            await repo.failRun({
              runId: claimed.id,
              leaseToken,
              error: String(turnErr),
            }).catch(() => undefined);
          }
        } else {
          // No run available, back off
          await new Promise(r => setTimeout(r, pollIntervalMs));
        }
      } catch {
        if (running) {
          await new Promise(r => setTimeout(r, pollIntervalMs));
        }
      }
    }
  };

  currentPromise = loop();

  return {
    async stop() {
      running = false;
      await currentPromise;
    },
  };
}

export async function runStandaloneWorker() {
  const databaseUrl = process.env.DATABASE_URL;
  let repo: InteractionRepository;
  let pool: pg.Pool | undefined;

  if (databaseUrl && databaseUrl !== 'memory') {
    const pgPool = new PgPool({ connectionString: databaseUrl });
    pgPool.on('error', () => {
      // Ignore background pool disconnects on shutdown
    });
    pool = pgPool;
    repo = createPgInteractionRepository({ pool: pgPool });
  } else {
    repo = createMemoryInteractionRepository();
  }

  console.log(`[Worker] Started agenda worker against ${databaseUrl && databaseUrl !== 'memory' ? 'PostgreSQL' : 'memory storage'}.`);
  const worker = startAgendaWorker({ repo, pool });

  const shutdown = async () => {
    console.log('[Worker] Shutting down worker...');
    await worker.stop();
    if (pool) await pool.end();
    console.log('[Worker] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  void runStandaloneWorker().catch(err => {
    console.error('Worker failed:', err);
    process.exit(1);
  });
}
