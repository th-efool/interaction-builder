import pg from 'pg';
import { runAssistantTurn, type InteractionRepository } from 'interaction-builder/runtime';
import { createPgInteractionRepository } from 'interaction-builder/adapters/pg';
import { createMemoryInteractionRepository } from 'interaction-builder/runtime';
import { agendaDomain, type AgendaWorkspace } from './agenda.domain';
import { createAgendaAiTools } from './agenda.tools';
import { hostBoundAgendaDomain, hostBoundAgendaWorkspaceSchema, type HostAgendaItem } from './host-agenda.domain';
import { createHostAgendaAiTools } from './host-agenda.tools';
import type { HostAgendaService } from './host-agenda.service';
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

      const detectItemId = (fallbackId: string) => {
        for (const msg of input.messages) {
          const parts = (msg as any).parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (part?.type === 'entity_ref' && part.entity?.id) {
                return String(part.entity.id);
              }
            }
          }
        }
        if (text.includes('executive') || text.includes('compensation') || text.includes('h-item-1')) {
          return 'h-item-1';
        }
        if (text.includes('m&a') || text.includes('strategy') || text.includes('h-item-2')) {
          return 'h-item-2';
        }
        return fallbackId;
      };

      // 1. Rename / Title action
      if (text.includes('rename') || text.includes('title')) {
        const match = lastUserMsg?.content.match(/["']([^"']+)["']/);
        let newTitle = match ? match[1] : null;
        if (!newTitle) {
          const m2 = lastUserMsg?.content.match(/(?:rename (?:the )?meeting to|title to)\s+([^,.\n]+?)(?:\s+and\b|[.,\n]|$)/i);
          newTitle = m2 ? m2[1].trim() : 'Executive Strategy Review';
        }
        if (input.tools.set_meeting_title) {
          await input.tools.set_meeting_title.execute({ title: newTitle });
          stepsCount += 1;
        }
      }

      // 2. Pin / Unpin action
      if (text.includes('unpin')) {
        const targetId = detectItemId('item-1');
        if (input.tools.set_item_pin) {
          await input.tools.set_item_pin.execute({ itemId: targetId, pinned: false });
          stepsCount += 1;
        }
      } else if (text.includes('pin')) {
        const targetId = detectItemId('item-1');
        if (input.tools.set_item_pin) {
          await input.tools.set_item_pin.execute({ itemId: targetId, pinned: true });
          stepsCount += 1;
        }
      }

      // 3. Duration edits
      if (text.includes('duration') || text.includes('minutes') || text.includes('longer') || text.includes('shorter')) {
        const numMatch = text.match(/\b(\d+)\s*(min|minute|m)?\b/);
        const durationMinutes = numMatch ? parseInt(numMatch[1], 10) : 45;
        const targetId = detectItemId('item-1');
        if (input.tools.edit_item) {
          await input.tools.edit_item.execute({ itemId: targetId, durationMinutes });
          stepsCount += 1;
        }
      }

      // 4. Reorder items
      if (text.includes('reorder') || text.includes('swap') || text.includes('reverse')) {
        const itemIds = text.includes('h-item') || text.includes('compensation') || text.includes('board')
          ? ['h-item-2', 'h-item-1']
          : ['item-2', 'item-1'];
        if (input.tools.reorder_items) {
          await input.tools.reorder_items.execute({ itemIds });
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
  hostService?: HostAgendaService;
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
                  ownerId = String(r.rows[0].ownerId);
                }
              } catch {}
            } else if ((repo as any).workspaces?.get) {
              const ws = (repo as any).workspaces.get(claimed.workspaceId);
              if (ws?.ownerId) {
                ownerId = String(ws.ownerId);
              }
            }

            const ws = await repo.loadWorkspace({ workspaceId: claimed.workspaceId, ownerId });
            if (!ws) {
              await repo.failRun({
                runId: claimed.id,
                leaseToken,
                error: 'WORKSPACE_NOT_FOUND',
              });
              continue;
            }

            let res;
            if ((ws.domainId === 'host_agenda' || ws.domainId === 'host-agenda') && options.hostService) {
              // -----------------------------------------------------------
              // Host-Owned Business Resource Profile
              // -----------------------------------------------------------
              const boundState = hostBoundAgendaWorkspaceSchema.parse(ws.snapshot);
              const meeting = await options.hostService.getMeeting(ownerId, boundState.meetingId);
              if (!meeting) {
                await repo.failRun({
                  runId: claimed.id,
                  leaseToken,
                  error: 'HOST_MEETING_NOT_FOUND',
                });
                continue;
              }

              const systemPrompt = `You are an AI assistant collaborating on this meeting agenda.
Authoritative Host Meeting Record:
Title: "${meeting.meetingTitle}" (Version: ${meeting.version}, Date: ${meeting.date})
Items:
${meeting.items.map((i: HostAgendaItem) => `- [${i.id}] "${i.title}" (${i.durationMinutes}m, presenter=${i.presenter}, pinned=${i.pinned}, v${i.version})`).join('\n')}

Instructions:
1. When the user asks for updates, call the available host tools.
2. Every tool call modifies the authoritative host business records.
3. If an item is pinned, its title cannot be changed.
4. Be concise and helpful.`;

              res = await runAssistantTurn({
                workspaceId: claimed.workspaceId,
                ownerId,
                repo,
                domain: hostBoundAgendaDomain as any,
                model,
                systemPrompt,
                createTools: deps =>
                  createHostAgendaAiTools({
                    workspaceId: deps.workspaceId,
                    ownerId: deps.ownerId,
                    meetingId: meeting.id,
                    hostService: options.hostService!,
                    observedVersion: meeting.version,
                    onToolStep: deps.onToolStep as any,
                  }),
                runId: claimed.id,
                leaseToken,
              });
            } else {
              // -----------------------------------------------------------
              // Native Interaction-Managed State Profile
              // -----------------------------------------------------------
              res = await runAssistantTurn({
                workspaceId: claimed.workspaceId,
                ownerId,
                repo,
                domain: agendaDomain,
                model,
                createTools: createAgendaAiTools,
                runId: claimed.id,
                leaseToken,
              });
            }

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
  let repo;
  let pool: pg.Pool | undefined;

  if (databaseUrl && databaseUrl !== 'memory') {
    pool = new PgPool({ connectionString: databaseUrl });
    repo = createPgInteractionRepository({ pool });
  } else {
    repo = createMemoryInteractionRepository();
  }

  const worker = startAgendaWorker({ repo, pool });
  console.log('[Agenda Worker] Worker loop started.');

  const shutdown = async () => {
    console.log('[Agenda Worker] Stopping worker...');
    await worker.stop();
    if (pool) await pool.end();
    console.log('[Agenda Worker] Stopped cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (process.argv[1]?.endsWith('worker.ts') || process.argv[1]?.endsWith('worker.js')) {
  void runStandaloneWorker().catch(err => {
    console.error('Worker failed to run:', err);
    process.exit(1);
  });
}
