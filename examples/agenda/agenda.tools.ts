import { z } from 'zod';
import { tool } from 'ai';
import { deterministicUuid, type InteractionRepository, type DomainDefinition } from 'interaction-builder/runtime';
import type { AgendaWorkspace } from './agenda.domain';

export function createAgendaAiTools(deps: {
  workspaceId: string;
  ownerId: string;
  repo: InteractionRepository;
  domain: DomainDefinition<AgendaWorkspace>;
  observedRevision: number;
  runFence?: { runId: string; leaseToken: string };
  onToolStep?: (toolName: string, inputPayload: unknown, actionFn: () => Promise<unknown>) => Promise<unknown>;
}) {
  let currentRevision = deps.observedRevision;

  const commit = async (action: unknown, summary: string, meta?: { ordinal: number; requestId: string }) => {
    const res = await deps.repo.commitAction({
      workspaceId: deps.workspaceId,
      ownerId: deps.ownerId,
      expectedRevision: currentRevision,
      envelope: {
        actionId: meta?.requestId ? deterministicUuid('action:' + meta.requestId) : crypto.randomUUID(),
        workspaceId: deps.workspaceId,
        expectedRevision: currentRevision,
        entityVersions: [],
        action,
      },
      plan: deps.domain.plan,
      runFence: deps.runFence,
      requestId: meta?.requestId,
    });
    currentRevision = res.revision;
    return res;
  };

  const wrapStep = async (
    name: string,
    payload: unknown,
    fn: (meta?: { ordinal: number; requestId: string }) => Promise<unknown>
  ) => {
    let res: any;
    if (deps.onToolStep) {
      res = await deps.onToolStep(name, payload, fn);
    } else {
      res = await fn();
    }
    if (res && typeof res.revision === 'number') {
      currentRevision = res.revision;
    }
    return res;
  };

  return {
    set_meeting_title: tool({
      description: 'Update the meeting title of the agenda.',
      inputSchema: z.object({
        title: z.string().describe('The new meeting title'),
      }),
      execute: async ({ title }) => {
        return wrapStep('set_meeting_title', { title }, async meta => {
          const res = await commit({ type: 'set_meeting_title', title }, `Set title to ${title}`, meta);
          return { success: true, title: res.state.meetingTitle, revision: res.revision };
        });
      },
    }),

    edit_item: tool({
      description: 'Edit an agenda item title or duration.',
      inputSchema: z.object({
        itemId: z.string(),
        title: z.string().optional(),
        durationMinutes: z.number().optional(),
      }),
      execute: async ({ itemId, title, durationMinutes }) => {
        return wrapStep('edit_item', { itemId, title, durationMinutes }, async meta => {
          const res = await commit({ type: 'edit_item', itemId, title, durationMinutes }, `Edit item ${itemId}`, meta);
          return { success: true, revision: res.revision };
        });
      },
    }),

    set_item_pin: tool({
      description: 'Pin or unpin an agenda item to protect it from AI changes.',
      inputSchema: z.object({
        itemId: z.string(),
        pinned: z.boolean(),
      }),
      execute: async ({ itemId, pinned }) => {
        return wrapStep('set_item_pin', { itemId, pinned }, async meta => {
          const res = await commit({ type: 'set_item_pin', itemId, pinned }, `Pin item ${itemId}`, meta);
          return { success: true, revision: res.revision };
        });
      },
    }),

    reorder_items: tool({
      description: 'Reorder agenda items by providing the full array of item IDs in desired order.',
      inputSchema: z.object({
        itemIds: z.array(z.string()),
      }),
      execute: async ({ itemIds }) => {
        return wrapStep('reorder_items', { itemIds }, async meta => {
          const res = await commit({ type: 'reorder_items', itemIds }, 'Reorder items', meta);
          return { success: true, revision: res.revision };
        });
      },
    }),
  };
}
