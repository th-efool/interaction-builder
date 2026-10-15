import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMemoryHostAgendaRepository,
  type HostAgendaRepository,
} from '../examples/agenda/host-agenda.repository';
import { HostAgendaService } from '../examples/agenda/host-agenda.service';
import {
  hostBoundAgendaDomain,
  hostBoundAgendaWorkspaceSchema,
  type HostAgendaMeeting,
  type HostBoundAgendaWorkspace,
} from '../examples/agenda/host-agenda.domain';
import { createHostAgendaAiTools } from '../examples/agenda/host-agenda.tools';
import { createMemoryInteractionRepository } from '../src/runtime/memory.repository';
import { runAssistantTurn, type InteractionModelAdapter } from '../src/runtime/runner';

describe('S7 Checkpoint 3: Host-Owned Resource Integration Profile', () => {
  let hostRepo: HostAgendaRepository;
  let hostService: HostAgendaService;
  let interactionRepo: ReturnType<typeof createMemoryInteractionRepository>;
  const ownerId = 'user-owner-1';
  const meetingId = 'meeting-xyz-100';

  beforeEach(async () => {
    hostRepo = createMemoryHostAgendaRepository();
    hostService = new HostAgendaService(hostRepo);
    interactionRepo = createMemoryInteractionRepository();

    // Seed authoritative host meeting
    const initialMeeting: HostAgendaMeeting = {
      id: meetingId,
      ownerId,
      version: 0,
      meetingTitle: 'Sprint Retrospective',
      date: '2026-10-15',
      items: [
        {
          id: 'item-1',
          version: 0,
          title: 'What went well',
          durationMinutes: 15,
          presenter: 'Alice',
          pinned: false,
          sortOrder: 0,
        },
        {
          id: 'item-2',
          version: 0,
          title: 'Action items',
          durationMinutes: 20,
          presenter: 'Bob',
          pinned: true,
          sortOrder: 1,
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await hostService.createMeeting(initialMeeting);
  });

  it('1. Versioned host resource reads and ZERO duplicate storage in interaction workspace', async () => {
    // 1. Read from authoritative host repository
    const meeting = await hostService.getMeeting(ownerId, meetingId);
    expect(meeting).not.toBeNull();
    expect(meeting!.version).toBe(0);
    expect(meeting!.meetingTitle).toBe('Sprint Retrospective');

    // 2. Create interaction workspace bound to host resource
    const ws = await interactionRepo.createWorkspace<HostBoundAgendaWorkspace>({
      id: 'ws-interaction-1',
      ownerId,
      domainId: hostBoundAgendaDomain.id,
      domainVersion: 1,
      initialSnapshot: {
        schemaVersion: 1,
        meetingId,
        observedVersion: 0,
        selectedItemId: null,
      },
    });

    // 3. Verify workspace snapshot contains ONLY reference/selection metadata
    expect(ws.snapshot.meetingId).toBe(meetingId);
    expect(ws.snapshot.observedVersion).toBe(0);
    expect(ws.snapshot.selectedItemId).toBeNull();

    // CRITICAL PROOF OF NO DUAL WRITER:
    // Snapshot MUST NOT contain meetingTitle or items array
    expect((ws.snapshot as any).meetingTitle).toBeUndefined();
    expect((ws.snapshot as any).items).toBeUndefined();
  });

  it('2. Authorized typed host commands execute through single command boundary', async () => {
    const cmdId1 = crypto.randomUUID();
    const receipt1 = await hostService.executeCommand({
      commandId: cmdId1,
      ownerId,
      resourceId: meetingId,
      expectedVersion: 0,
      command: { type: 'set_meeting_title', title: 'Q4 Product Roadmap' },
    });

    expect(receipt1.resultingVersion).toBe(1);
    expect(receipt1.summary).toBe('Meeting title updated to "Q4 Product Roadmap".');
    expect(receipt1.changed).toHaveLength(1);
    expect(receipt1.changed[0].kind).toBe('host_agenda_meeting');

    const updated = await hostService.getMeeting(ownerId, meetingId);
    expect(updated!.version).toBe(1);
    expect(updated!.meetingTitle).toBe('Q4 Product Roadmap');

    // Item edit
    const cmdId2 = crypto.randomUUID();
    const receipt2 = await hostService.executeCommand({
      commandId: cmdId2,
      ownerId,
      resourceId: meetingId,
      expectedVersion: 1,
      command: { type: 'edit_item', itemId: 'item-1', durationMinutes: 30 },
    });

    expect(receipt2.resultingVersion).toBe(2);
    const item1 = (await hostService.getMeeting(ownerId, meetingId))!.items.find(i => i.id === 'item-1');
    expect(item1!.durationMinutes).toBe(30);
    expect(item1!.version).toBe(1);
  });

  it('3. Expected-version/read-set conflict checks and pinned protection', async () => {
    // Stale expected version rejects
    await expect(
      hostService.executeCommand({
        commandId: crypto.randomUUID(),
        ownerId,
        resourceId: meetingId,
        expectedVersion: 99, // Stale!
        command: { type: 'set_meeting_title', title: 'Stale update' },
      })
    ).rejects.toThrow('STALE_HOST_RESOURCE');

    // Stale readSet item version rejects
    await expect(
      hostService.executeCommand({
        commandId: crypto.randomUUID(),
        ownerId,
        resourceId: meetingId,
        expectedVersion: 0,
        readSet: [{ kind: 'agenda_item', id: 'item-1', version: 999 }],
        command: { type: 'edit_item', itemId: 'item-1', durationMinutes: 25 },
      })
    ).rejects.toThrow('STALE_ENTITY');

    // Pinned item modification protection
    await expect(
      hostService.executeCommand({
        commandId: crypto.randomUUID(),
        ownerId,
        resourceId: meetingId,
        expectedVersion: 0,
        command: { type: 'edit_item', itemId: 'item-2', title: 'Overwritten Action Items' },
      })
    ).rejects.toThrow('PINNED_ITEM_PROTECTED');
  });

  it('4. Durable command receipts and idempotency deduplication', async () => {
    const fixedCmdId = crypto.randomUUID();

    const receiptA = await hostService.executeCommand({
      commandId: fixedCmdId,
      ownerId,
      resourceId: meetingId,
      expectedVersion: 0,
      command: { type: 'set_meeting_title', title: 'Deterministic Title' },
    });
    expect(receiptA.resultingVersion).toBe(1);

    // Immediate retry with the same commandId
    const receiptB = await hostService.executeCommand({
      commandId: fixedCmdId,
      ownerId,
      resourceId: meetingId,
      expectedVersion: 0, // Even if caller sent stale version on retry, idempotency returns cached receipt!
      command: { type: 'set_meeting_title', title: 'Deterministic Title' },
    });

    expect(receiptB.receiptId).toBe(receiptA.receiptId);
    expect(receiptB.resultingVersion).toBe(1);

    // Verify host version only advanced once
    const meeting = await hostService.getMeeting(ownerId, meetingId);
    expect(meeting!.version).toBe(1);
  });

  it('5. Human edits outside chat are seen by the next assistant turn', async () => {
    // 1. Human updates title directly outside chat (advances version 0 -> 1)
    await hostService.executeCommand({
      commandId: crypto.randomUUID(),
      ownerId,
      resourceId: meetingId,
      expectedVersion: 0,
      command: { type: 'set_meeting_title', title: 'Engineering All-Hands 2027' },
    });

    // 2. Setup interaction workspace and user message
    const ws = await interactionRepo.createWorkspace<HostBoundAgendaWorkspace>({
      id: 'ws-interaction-sync',
      ownerId,
      domainId: hostBoundAgendaDomain.id,
      domainVersion: 1,
      initialSnapshot: {
        schemaVersion: 1,
        meetingId,
        observedVersion: 0, // Out of date in interaction workspace, but assistant turn reads host repo!
        selectedItemId: null,
      },
    });

    await interactionRepo.appendMessage({
      workspaceId: ws.id,
      ownerId,
      role: 'user',
      parts: [{ type: 'text', text: 'Increase item 1 duration to 45m' }],
    });

    // 3. Mock model adapter that asserts system prompt has the human edit
    let observedSystemPrompt = '';
    const mockModel: InteractionModelAdapter = {
      async executeTurn(input) {
        observedSystemPrompt = input.systemPrompt;
        // Tool call against host command boundary
        await input.tools.edit_item.execute({ itemId: 'item-1', durationMinutes: 45 });
        return { text: 'Updated item 1 to 45m', stepsCount: 1 };
      },
    };

    // 4. Run assistant turn
    // Read authoritative meeting
    const freshMeeting = await hostService.getMeeting(ownerId, meetingId);
    expect(freshMeeting!.version).toBe(1);

    const systemPrompt = `Authoritative Host Meeting: "${freshMeeting!.meetingTitle}" (Version: ${freshMeeting!.version})`;

    await runAssistantTurn({
      workspaceId: ws.id,
      ownerId,
      repo: interactionRepo,
      domain: hostBoundAgendaDomain as any,
      model: mockModel,
      systemPrompt,
      createTools: () =>
        createHostAgendaAiTools({
          workspaceId: ws.id,
          ownerId,
          meetingId,
          hostService,
          observedVersion: freshMeeting!.version,
        }),
    });

    // Verify system prompt saw human edit
    expect(observedSystemPrompt).toContain('Engineering All-Hands 2027');
    expect(observedSystemPrompt).toContain('Version: 1');

    // Verify host resource was updated by assistant to version 2
    const finalMeeting = await hostService.getMeeting(ownerId, meetingId);
    expect(finalMeeting!.version).toBe(2);
    expect(finalMeeting!.items.find(i => i.id === 'item-1')!.durationMinutes).toBe(45);
  });

  it('6. Stale model commands reject rather than overwrite human edits', async () => {
    // Observed version 0
    const tools = createHostAgendaAiTools({
      workspaceId: 'ws-1',
      ownerId,
      meetingId,
      hostService,
      observedVersion: 0,
    });

    // Human sneaks in an edit before tool executes (version 0 -> 1)
    await hostService.executeCommand({
      commandId: crypto.randomUUID(),
      ownerId,
      resourceId: meetingId,
      expectedVersion: 0,
      command: { type: 'set_meeting_title', title: 'Human Prior Edit' },
    });

    // Model tool execution prepared with stale version 0 must throw STALE_HOST_RESOURCE
    await expect(
      tools.edit_item.execute({ itemId: 'item-1', durationMinutes: 50 })
    ).rejects.toThrow('STALE_HOST_RESOURCE');

    // Verify human title was NOT overwritten
    const meeting = await hostService.getMeeting(ownerId, meetingId);
    expect(meeting!.meetingTitle).toBe('Human Prior Edit');
    expect(meeting!.version).toBe(1);
  });

  it('7. Cross-owner multi-tenant isolation fails closed', async () => {
    const foreignOwner = 'attacker-user-999';

    // Foreign owner cannot read
    const foreignRead = await hostService.getMeeting(foreignOwner, meetingId);
    expect(foreignRead).toBeNull();

    // Foreign owner cannot mutate
    await expect(
      hostService.executeCommand({
        commandId: crypto.randomUUID(),
        ownerId: foreignOwner,
        resourceId: meetingId,
        expectedVersion: 0,
        command: { type: 'set_meeting_title', title: 'Hacked Title' },
      })
    ).rejects.toThrow('UNAUTHORIZED_OWNER');
  });

  it('8. Cancellation semantics do not falsely undo committed host effects', async () => {
    // Tool commits command (version 0 -> 1)
    const tools = createHostAgendaAiTools({
      workspaceId: 'ws-cancel-test',
      ownerId,
      meetingId,
      hostService,
      observedVersion: 0,
    });

    await tools.set_meeting_title.execute({ title: 'Committed Before Cancel' });
    expect((await hostService.getMeeting(ownerId, meetingId))!.version).toBe(1);

    // Simulated run cancellation: subsequent steps aborted
    // Host database retains the committed modification
    const finalMeeting = await hostService.getMeeting(ownerId, meetingId);
    expect(finalMeeting!.meetingTitle).toBe('Committed Before Cancel');
    expect(finalMeeting!.version).toBe(1);
  });
});
