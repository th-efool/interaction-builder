import type { HostCommandEnvelope, HostCommandReceipt, EntityRef } from 'interaction-builder/core';
import type { HostAgendaRepository } from './host-agenda.repository';
import {
  hostAgendaCommandSchema,
  type HostAgendaCommand,
  type HostAgendaMeeting,
  type HostAgendaItem,
} from './host-agenda.domain';

export class HostAgendaService {
  private repo: HostAgendaRepository;

  constructor(repoOrDeps: HostAgendaRepository | { repo: HostAgendaRepository }) {
    if (repoOrDeps && typeof repoOrDeps === 'object' && 'repo' in repoOrDeps) {
      this.repo = (repoOrDeps as any).repo;
    } else {
      this.repo = repoOrDeps as HostAgendaRepository;
    }
  }

  async getMeeting(ownerId: string, meetingId: string): Promise<HostAgendaMeeting | null> {
    return this.repo.getMeeting(ownerId, meetingId);
  }

  async createMeeting(meeting: HostAgendaMeeting): Promise<HostAgendaMeeting> {
    return this.repo.createMeeting(meeting);
  }

  async getReceipt(ownerId: string, commandId: string): Promise<HostCommandReceipt | null> {
    return this.repo.getReceipt(ownerId, commandId);
  }

  /**
   * Authorized typed host command boundary.
   *
   * Both direct human UI actions AND model-tool executions MUST pass through this boundary.
   * Enforces:
   * 1. Multi-tenant owner authorization.
   * 2. Idempotency deduplication via commandId.
   * 3. Expected-version CAS verification.
   * 4. Read-set conflict verification.
   * 5. Atomic state modification in one transaction.
   */
  async executeCommand(
    envelope: HostCommandEnvelope<HostAgendaCommand>
  ): Promise<HostCommandReceipt> {
    const command = hostAgendaCommandSchema.parse(envelope.command);

    const { receipt } = await this.repo.executeCommandTransaction({
      ownerId: envelope.ownerId,
      meetingId: envelope.resourceId,
      expectedVersion: envelope.expectedVersion,
      commandId: envelope.commandId,
      readSet: envelope.readSet,
      mutate: (meeting: HostAgendaMeeting) => {
        const changed: EntityRef[] = [];

        if (command.type === 'set_meeting_title') {
          meeting.meetingTitle = command.title;
          changed.push({
            kind: 'host_agenda_meeting',
            id: meeting.id,
            version: meeting.version + 1,
          });
          return {
            summary: `Meeting title updated to "${command.title}".`,
            changed,
          };
        }

        if (command.type === 'edit_item') {
          const item = meeting.items.find(i => i.id === command.itemId);
          if (!item) {
            throw new Error(`UNKNOWN_AGENDA_ITEM: Item "${command.itemId}" not found in meeting.`);
          }
          if (command.title !== undefined && item.pinned) {
            throw new Error(`PINNED_ITEM_PROTECTED: Item "${item.id}" is pinned and cannot be edited by assistant.`);
          }
          if (command.title !== undefined) item.title = command.title;
          if (command.durationMinutes !== undefined) item.durationMinutes = command.durationMinutes;
          item.version += 1;
          changed.push({
            kind: 'agenda_item',
            id: item.id,
            version: item.version,
          });
          return {
            summary: `Agenda item "${item.id}" updated.`,
            changed,
          };
        }

        if (command.type === 'set_item_pin') {
          const item = meeting.items.find(i => i.id === command.itemId);
          if (!item) {
            throw new Error(`UNKNOWN_AGENDA_ITEM: Item "${command.itemId}" not found in meeting.`);
          }
          item.pinned = command.pinned;
          item.version += 1;
          changed.push({
            kind: 'agenda_item',
            id: item.id,
            version: item.version,
          });
          return {
            summary: command.pinned ? `Item "${item.id}" pinned.` : `Item "${item.id}" unpinned.`,
            changed,
          };
        }

        if (command.type === 'reorder_items') {
          const currentIds = new Set(meeting.items.map(i => i.id));
          if (
            command.itemIds.length !== meeting.items.length ||
            command.itemIds.some(id => !currentIds.has(id)) ||
            new Set(command.itemIds).size !== command.itemIds.length
          ) {
            throw new Error('INVALID_AGENDA_ORDER: Item IDs array must match existing items.');
          }
          const byId = new Map(meeting.items.map(i => [i.id, i]));
          meeting.items = command.itemIds.map((id, index) => {
            const item = byId.get(id)!;
            item.sortOrder = index;
            item.version += 1;
            changed.push({
              kind: 'agenda_item',
              id: item.id,
              version: item.version,
            });
            return item;
          });
          return {
            summary: 'Agenda items reordered.',
            changed,
          };
        }

        throw new Error('UNSUPPORTED_HOST_COMMAND');
      },
    });

    return receipt;
  }
}
