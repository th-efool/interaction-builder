import { z } from 'zod';
import { tool } from 'ai';
import { deterministicUuid } from 'interaction-builder/runtime';
import type { HostCommandEnvelope } from 'interaction-builder/core';
import type { HostAgendaService } from './host-agenda.service';
import type { HostAgendaCommand } from './host-agenda.domain';

export function createHostAgendaAiTools(deps: {
  workspaceId: string;
  ownerId: string;
  meetingId: string;
  hostService: HostAgendaService;
  observedVersion: number;
  onToolStep?: (
    toolName: string,
    inputPayload: unknown,
    actionFn: (meta?: { ordinal: number; requestId: string }) => Promise<unknown>
  ) => Promise<unknown>;
}) {
  let currentObservedVersion = deps.observedVersion;

  const executeCommand = async (
    command: HostAgendaCommand,
    meta?: { ordinal: number; requestId: string }
  ) => {
    const envelope: HostCommandEnvelope<HostAgendaCommand> = {
      commandId: meta?.requestId ? deterministicUuid('host-cmd:' + meta.requestId) : crypto.randomUUID(),
      ownerId: deps.ownerId,
      resourceId: deps.meetingId,
      expectedVersion: currentObservedVersion,
      command,
    };

    const receipt = await deps.hostService.executeCommand(envelope);
    currentObservedVersion = receipt.resultingVersion;
    return receipt;
  };

  const wrapStep = async (
    name: string,
    payload: unknown,
    fn: (meta?: { ordinal: number; requestId: string }) => Promise<unknown>
  ) => {
    if (deps.onToolStep) {
      return deps.onToolStep(name, payload, fn);
    }
    return fn();
  };

  return {
    set_meeting_title: tool({
      description: 'Update the meeting title of the host agenda meeting.',
      inputSchema: z.object({
        title: z.string().describe('The new meeting title'),
      }),
      execute: async ({ title }) => {
        return wrapStep('set_meeting_title', { title }, async meta => {
          const receipt = await executeCommand({ type: 'set_meeting_title', title }, meta);
          return { success: true, title, resultingVersion: receipt.resultingVersion };
        });
      },
    }),

    edit_item: tool({
      description: 'Edit an agenda item title or duration in the host agenda.',
      inputSchema: z.object({
        itemId: z.string(),
        title: z.string().optional(),
        durationMinutes: z.number().optional(),
      }),
      execute: async ({ itemId, title, durationMinutes }) => {
        return wrapStep('edit_item', { itemId, title, durationMinutes }, async meta => {
          const receipt = await executeCommand({ type: 'edit_item', itemId, title, durationMinutes }, meta);
          return { success: true, resultingVersion: receipt.resultingVersion, summary: receipt.summary };
        });
      },
    }),

    set_item_pin: tool({
      description: 'Pin or unpin an agenda item to protect it from AI changes in the host agenda.',
      inputSchema: z.object({
        itemId: z.string(),
        pinned: z.boolean(),
      }),
      execute: async ({ itemId, pinned }) => {
        return wrapStep('set_item_pin', { itemId, pinned }, async meta => {
          const receipt = await executeCommand({ type: 'set_item_pin', itemId, pinned }, meta);
          return { success: true, resultingVersion: receipt.resultingVersion, summary: receipt.summary };
        });
      },
    }),

    reorder_items: tool({
      description: 'Reorder agenda items in the host agenda by providing the full array of item IDs.',
      inputSchema: z.object({
        itemIds: z.array(z.string()),
      }),
      execute: async ({ itemIds }) => {
        return wrapStep('reorder_items', { itemIds }, async meta => {
          const receipt = await executeCommand({ type: 'reorder_items', itemIds }, meta);
          return { success: true, resultingVersion: receipt.resultingVersion, summary: receipt.summary };
        });
      },
    }),
  };
}
