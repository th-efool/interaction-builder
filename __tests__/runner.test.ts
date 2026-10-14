import { describe, expect, it } from 'vitest';
import { MemoryInteractionRepository } from '../src/runtime/memory.repository';
import { computePayloadHash } from '../src/runtime/repository';
import { runAssistantTurn } from '../src/runtime/runner';
import { agendaDomain, sampleAgenda, type AgendaWorkspace } from '../src/testkit/agenda-domain';
import { createAgendaAiTools } from '../examples/agenda/agenda.tools';
import { createScriptedModelAdapter, createScriptedLanguageModel } from '../src/testkit/mock-model';
import { createAiSdkModelAdapter } from '../src/adapters/ai';

const WS = '7b91950e-561b-4fbc-bdf5-d4e51147a4f9';

describe('Generic Assistant Runner & Durable Replay', () => {
  it('binds a run to its triggering message even if a newer user message arrives', async () => {
    const repo = new MemoryInteractionRepository();
    await repo.createWorkspace({ id: WS, ownerId: 'user-1', domainId: 'agenda', domainVersion: 1, initialSnapshot: sampleAgenda });
    const first = await repo.appendMessage({ workspaceId: WS, ownerId: 'user-1', id: crypto.randomUUID(), role: 'user',
      parts: [{ type: 'text', text: 'First request' }] });
    await repo.appendMessage({ workspaceId: WS, ownerId: 'user-1', id: crypto.randomUUID(), role: 'user',
      parts: [{ type: 'text', text: 'Later request' }] });
    const leaseToken = crypto.randomUUID();
    await repo.claimRun({ workspaceId: WS, leaseOwner: 'worker', leaseToken, leaseDurationMs: 60_000 });
    let seen: string[] = [];
    await runAssistantTurn({ workspaceId: WS, ownerId: 'user-1', repo, domain: agendaDomain,
      model: { executeTurn: async ({ messages }) => { seen = messages.map(message => message.content); return { text: 'Done', stepsCount: 0 }; } },
      createTools: () => ({}), runId: first.run!.id, leaseToken,
    });
    expect(seen).toEqual(['First request']);
  });

  it('executes model tool calls against commitAction and appends assistant response', async () => {
    const repo = new MemoryInteractionRepository();
    await repo.createWorkspace({
      id: WS,
      ownerId: 'user-1',
      domainId: 'agenda',
      domainVersion: 1,
      initialSnapshot: sampleAgenda,
    });

    await repo.appendMessage({
      workspaceId: WS,
      ownerId: 'user-1',
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'Please rename meeting to Engineering Architecture Review' }],
    });

    const model = createScriptedModelAdapter([
      {
        toolCalls: [
          {
            toolName: 'set_meeting_title',
            input: { title: 'Engineering Architecture Review' },
          },
        ],
      },
      {
        text: 'I updated the meeting title.',
      },
    ]);

    const res = await runAssistantTurn({
      workspaceId: WS,
      ownerId: 'user-1',
      repo,
      domain: agendaDomain,
      model,
      createTools: (deps: any) => createAgendaAiTools(deps),
    });

    expect(res.assistantMessageId).toBeDefined();
    const ws = await repo.loadWorkspace<AgendaWorkspace>({ workspaceId: WS, ownerId: 'user-1' });
    expect(ws?.revision).toBe(1);
    expect(ws?.snapshot.meetingTitle).toBe('Engineering Architecture Review');
  });

  it('works with createAiSdkModelAdapter wrapping LanguageModel', async () => {
    const repo = new MemoryInteractionRepository();
    const wsId = crypto.randomUUID();
    await repo.createWorkspace({
      id: wsId,
      ownerId: 'user-1',
      domainId: 'agenda',
      domainVersion: 1,
      initialSnapshot: sampleAgenda,
    });

    await repo.appendMessage({
      workspaceId: wsId,
      ownerId: 'user-1',
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'Rename to AI Sync' }],
    });

    const aiModel = createScriptedLanguageModel([
      {
        toolCalls: [
          {
            toolName: 'set_meeting_title',
            input: { title: 'AI Sync' },
          },
        ],
      },
      {
        text: 'Updated title to AI Sync.',
      },
    ]);

    const model = createAiSdkModelAdapter(aiModel);

    const res = await runAssistantTurn({
      workspaceId: wsId,
      ownerId: 'user-1',
      repo,
      domain: agendaDomain,
      model,
      createTools: (deps: any) => createAgendaAiTools(deps),
    });

    expect(res.text).toContain('AI Sync');
    const ws = await repo.loadWorkspace<AgendaWorkspace>({ workspaceId: wsId, ownerId: 'user-1' });
    expect(ws?.revision).toBe(1);
    expect(ws?.snapshot.meetingTitle).toBe('AI Sync');
  });

  it('recovers from interrupted run: replays completed step without re-committing mutation', async () => {
    const repo = new MemoryInteractionRepository();
    const wsId = crypto.randomUUID();
    await repo.createWorkspace({
      id: wsId,
      ownerId: 'user-1',
      domainId: 'agenda',
      domainVersion: 1,
      initialSnapshot: sampleAgenda,
    });

    await repo.appendMessage({
      workspaceId: wsId,
      ownerId: 'user-1',
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'Update title and duration' }],
    });

    const run = await repo.scheduleRun({ workspaceId: wsId, ownerId: 'user-1' });
    const leaseToken = crypto.randomUUID();
    await repo.claimRun({
      workspaceId: wsId,
      leaseOwner: 'worker-1',
      leaseToken,
      leaseDurationMs: 60_000,
    });

    // Run 1: Interrupted/crashes after step 1 tool commit
    let commitsCount = 0;
    const toolsWithFailure = (deps: any) => {
      const standardTools = createAgendaAiTools(deps);
      return {
        ...standardTools,
        set_meeting_title: {
          ...standardTools.set_meeting_title,
          execute: async (input: any) => {
            commitsCount += 1;
            const out = await (standardTools.set_meeting_title as any).execute(input);
            // Simulate crash after step 1 completion
            throw new Error('CRASH_AFTER_STEP_1');
          },
        },
      };
    };

    const modelTurn1 = createScriptedModelAdapter([
      {
        toolCalls: [
          {
            toolName: 'set_meeting_title',
            input: { title: 'First Interrupted Title' },
          },
        ],
      },
    ]);

    await expect(
      runAssistantTurn({
        workspaceId: wsId,
        ownerId: 'user-1',
        repo,
        domain: agendaDomain,
        model: modelTurn1,
        createTools: toolsWithFailure,
        runId: run.id,
        leaseToken,
      })
    ).rejects.toThrow('CRASH_AFTER_STEP_1');

    // State at crash: revision was committed to 1
    const wsAfterCrash = await repo.loadWorkspace<AgendaWorkspace>({ workspaceId: wsId, ownerId: 'user-1' });
    expect(wsAfterCrash?.revision).toBe(1);
    expect(commitsCount).toBe(1);

    // Run 2: Worker restarts run with same runId and leaseToken
    // Model repeats the turn: step 1 (set_meeting_title) and then step 2 (edit_item)
    const modelRecovery = createScriptedModelAdapter([
      {
        toolCalls: [
          {
            toolName: 'set_meeting_title',
            input: { title: 'First Interrupted Title' },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: 'edit_item',
            input: { itemId: 'item-1', durationMinutes: 45 },
          },
        ],
      },
      {
        text: 'Recovery complete.',
      },
    ]);

    // Tracking commits on recovery
    let recoveryCommits = 0;
    const toolsOnRecovery = (deps: any) => {
      const standardTools = createAgendaAiTools(deps);
      return {
        ...standardTools,
        set_meeting_title: {
          ...standardTools.set_meeting_title,
          execute: async (input: any) => {
            recoveryCommits += 1;
            return (standardTools.set_meeting_title as any).execute(input);
          },
        },
        edit_item: {
          ...standardTools.edit_item,
          execute: async (input: any) => {
            recoveryCommits += 1;
            return (standardTools.edit_item as any).execute(input);
          },
        },
      };
    };

    const recoveryRes = await runAssistantTurn({
      workspaceId: wsId,
      ownerId: 'user-1',
      repo,
      domain: agendaDomain,
      model: modelRecovery,
      createTools: toolsOnRecovery,
      runId: run.id,
      leaseToken,
    });

    expect(recoveryRes.success).toBe(true);
    const finalWs = await repo.loadWorkspace<AgendaWorkspace>({ workspaceId: wsId, ownerId: 'user-1' });
    // Final revision should be 2 (step 1 was not re-committed, step 2 was committed)
    expect(finalWs?.revision).toBe(2);
    expect(finalWs?.snapshot.meetingTitle).toBe('First Interrupted Title');
    expect(finalWs?.snapshot.items.find(i => i.id === 'item-1')?.durationMinutes).toBe(45);
  });

  it('rejects divergent tool call on replay recovery', async () => {
    const repo = new MemoryInteractionRepository();
    const wsId = crypto.randomUUID();
    await repo.createWorkspace({
      id: wsId,
      ownerId: 'user-1',
      domainId: 'agenda',
      domainVersion: 1,
      initialSnapshot: sampleAgenda,
    });

    await repo.appendMessage({
      workspaceId: wsId,
      ownerId: 'user-1',
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'Update agenda please' }],
    });

    const run = await repo.scheduleRun({ workspaceId: wsId, ownerId: 'user-1' });
    const leaseToken = crypto.randomUUID();
    await repo.claimRun({
      workspaceId: wsId,
      leaseOwner: 'worker-1',
      leaseToken,
      leaseDurationMs: 60_000,
    });

    // Manually seed step 1 as completed with a specific tool and input
    await repo.recordStep({
      runId: run.id,
      leaseToken,
      ordinal: 1,
      kind: 'tool_call',
      toolName: 'set_meeting_title',
      inputPayload: { title: 'Original Input' },
      inputHash: 'hash-original',
      state: 'completed',
      result: { success: true },
    });

    // Model tries to call a DIFFERENT tool at ordinal 1 during replay
    const divergentModel = createScriptedModelAdapter([
      {
        toolCalls: [
          {
            toolName: 'edit_item', // Divergence!
            input: { itemId: 'item-1' },
          },
        ],
      },
    ]);

    await expect(
      runAssistantTurn({
        workspaceId: wsId,
        ownerId: 'user-1',
        repo,
        domain: agendaDomain,
        model: divergentModel,
        createTools: (deps: any) => createAgendaAiTools(deps),
        runId: run.id,
        leaseToken,
      })
    ).rejects.toThrow('DIVERGENT_REPLAY');
  });

  it('correctly replays steps where result was null without re-executing action', async () => {
    const repo = new MemoryInteractionRepository();
    const wsId = crypto.randomUUID();
    await repo.createWorkspace({
      id: wsId,
      ownerId: 'user-1',
      domainId: 'agenda',
      domainVersion: 1,
      initialSnapshot: sampleAgenda,
    });

    await repo.appendMessage({
      workspaceId: wsId,
      ownerId: 'user-1',
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'Please update' }],
    });

    const run = await repo.scheduleRun({ workspaceId: wsId, ownerId: 'user-1' });
    const leaseToken = 'lease-null-test';
    await repo.claimRun({
      leaseOwner: 'worker-1',
      leaseToken,
      leaseDurationMs: 60_000,
    });

    // Seed step 1 as completed with null result
    const inputPayload = { title: 'Null Test Title' };
    await repo.recordStep({
      runId: run.id,
      leaseToken,
      ordinal: 1,
      kind: 'tool_call',
      toolName: 'set_meeting_title',
      inputPayload,
      inputHash: computePayloadHash(inputPayload),
      state: 'completed',
      result: null,
    });

    let toolExecuted = false;
    const model = createScriptedModelAdapter([
      {
        toolCalls: [
          {
            toolName: 'set_meeting_title',
            input: { title: 'Null Test Title' },
          },
        ],
      },
      { text: 'Done' },
    ]);

    const res = await runAssistantTurn({
      workspaceId: wsId,
      ownerId: 'user-1',
      repo,
      domain: agendaDomain,
      model,
      createTools: (deps: any) => ({
        set_meeting_title: {
          description: 'Set title',
          parameters: {} as any,
          execute: async (input: any) => {
            return deps.onToolStep('set_meeting_title', input, async () => {
              toolExecuted = true;
              return { ok: true };
            });
          },
        },
      }),
      runId: run.id,
      leaseToken,
    });

    expect(res.success).toBe(true);
    // Tool must NOT have been re-executed because step 1 was completed (even with null result)
    expect(toolExecuted).toBe(false);
  });

  it('aborts turn when AbortSignal is triggered before or during tool execution', async () => {
    const repo = new MemoryInteractionRepository();
    const wsId = crypto.randomUUID();
    await repo.createWorkspace({
      id: wsId,
      ownerId: 'user-1',
      domainId: 'agenda',
      domainVersion: 1,
      initialSnapshot: sampleAgenda,
    });

    await repo.appendMessage({
      workspaceId: wsId,
      ownerId: 'user-1',
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'Please abort me' }],
    });

    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const model = createScriptedModelAdapter([{ text: 'Never reached' }]);

    await expect(
      runAssistantTurn({
        workspaceId: wsId,
        ownerId: 'user-1',
        repo,
        domain: agendaDomain,
        model,
        createTools: () => ({}),
        signal: controller.signal,
      })
    ).rejects.toThrow('RUN_ABORTED');
  });
});
