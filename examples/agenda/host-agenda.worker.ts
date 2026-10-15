import pg from 'pg';
import { runAssistantTurn, type InteractionRepository } from 'interaction-builder/runtime';
import { createDeterministicAgendaModelAdapter } from './worker';
import { hostBoundAgendaDomain, hostBoundAgendaWorkspaceSchema } from './host-agenda.domain';
import { HostAgendaService } from './host-agenda.service';
import { createHostAgendaAiTools } from './host-agenda.tools';

export interface HostAgendaWorkerOptions {
  repo: InteractionRepository;
  hostService: HostAgendaService;
  pollIntervalMs?: number;
  workerId?: string;
  leaseDurationMs?: number;
  pool?: pg.Pool;
}

export function startHostAgendaWorker(options: HostAgendaWorkerOptions) {
  const {
    repo,
    hostService,
    pollIntervalMs = 250,
    workerId = `host-agenda-worker-${crypto.randomUUID().slice(0, 8)}`,
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

        if (!claimed) {
          await new Promise(r => setTimeout(r, pollIntervalMs));
          continue;
        }

        const runId = claimed.id;
        const workspaceId = claimed.workspaceId;

        try {
          // Resolve ownerId
          let ownerId = 'agenda-user-default';
          if (options.pool) {
            const wsRes = await options.pool.query(
              'SELECT "ownerId" FROM "interaction_workspaces" WHERE "id" = $1',
              [workspaceId]
            );
            if (wsRes.rows[0]?.ownerId) {
              ownerId = String(wsRes.rows[0].ownerId);
            }
          }

          const ws = await repo.loadWorkspace({ workspaceId, ownerId });
          if (!ws) {
            await repo.failRun({
              runId,
              leaseToken,
              error: 'WORKSPACE_NOT_FOUND',
            });
            continue;
          }

          const boundState = hostBoundAgendaWorkspaceSchema.parse(ws.snapshot);

          // Read authoritative host resource from host repository
          const meeting = await hostService.getMeeting(ownerId, boundState.meetingId);
          if (!meeting) {
            await repo.failRun({
              runId,
              leaseToken,
              error: 'HOST_MEETING_NOT_FOUND',
            });
            continue;
          }

          const systemPrompt = `You are an AI assistant collaborating on this meeting agenda.
Authoritative Host Meeting Record:
Title: "${meeting.meetingTitle}" (Version: ${meeting.version}, Date: ${meeting.date})
Items:
${meeting.items.map(i => `- [${i.id}] "${i.title}" (${i.durationMinutes}m, presenter=${i.presenter}, pinned=${i.pinned}, v${i.version})`).join('\n')}

Instructions:
1. When the user asks for updates, call the available host tools.
2. Every tool call modifies the authoritative host business records.
3. If an item is pinned, its title cannot be changed.
4. Be concise and helpful.`;

          const result = await runAssistantTurn({
            workspaceId,
            ownerId,
            repo,
            domain: hostBoundAgendaDomain as any,
            model,
            runId,
            leaseToken,
            observedRevision: ws.revision,
            systemPrompt,
            createTools: deps =>
              createHostAgendaAiTools({
                workspaceId: deps.workspaceId,
                ownerId: deps.ownerId,
                meetingId: meeting.id,
                hostService,
                observedVersion: meeting.version,
                onToolStep: deps.onToolStep as any,
              }),
          });

          await repo.completeRun({
            runId,
            leaseToken,
            assistantMessageId: result.assistantMessageId,
          });
        } catch (turnError: any) {
          await repo.failRun({
            runId,
            leaseToken,
            error: turnError?.message || String(turnError),
          });
        }
      } catch {
        // Sleep on error before retrying poll
        await new Promise(r => setTimeout(r, pollIntervalMs));
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
