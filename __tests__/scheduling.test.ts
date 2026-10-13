import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { MemoryInteractionRepository } from '../src/runtime/memory.repository';
import { createInteractionHandlers } from '../src/runtime/handlers';
import { runAssistantTurn } from '../src/runtime/runner';
import { agendaDomain, type AgendaWorkspace } from '../examples/agenda/agenda.domain';
import { createAgendaAiTools } from '../examples/agenda/agenda.tools';
import { createAiSdkModelAdapter } from '../src/adapters/ai';

const initialSnapshot: AgendaWorkspace = {
  schemaVersion: 1,
  meetingTitle: 'Sprint Retrospective',
  date: '2026-10-15',
  items: [
    {
      id: 'item-1',
      version: 0,
      title: 'Action Item Review',
      durationMinutes: 15,
      presenter: 'Alice',
      pinned: false,
    },
  ],
};

const defaultUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

describe('Package Scheduling, Leases, Fencing, Replay, and Proposals', () => {
  const WS = '7b91950e-561b-4fbc-bdf5-d4e51147a4f9';
  const OWNER = 'test-owner-1';

  async function createFixture() {
    const repo = new MemoryInteractionRepository();
    const handlers = createInteractionHandlers({
      repo,
      domains: new Map([[agendaDomain.id, agendaDomain]]),
    });
    await handlers.createWorkspace(OWNER, {
      workspaceId: WS,
      domainId: 'agenda',
      bootstrap: initialSnapshot,
    });
    return { repo, handlers };
  }

  it('1. One submitted message produces one scheduled run with atomic outbox intent', async () => {
    const { repo, handlers } = await createFixture();

    const res = await handlers.sendMessage(OWNER, WS, 'req-msg-1', {
      id: crypto.randomUUID(),
      parts: [{ type: 'text', text: 'Rename to Global Retro' }],
    });

    expect(res.status).toBe(202);
    const body = res.body as any;
    expect(body.runId).toBeDefined();
    expect(body.cursor).toBe(1);

    const activeRun = await repo.getActiveRun({ workspaceId: WS, ownerId: OWNER });
    expect(activeRun).not.toBeNull();
    expect(activeRun?.id).toBe(body.runId);
    expect(activeRun?.status).toBe('queued');

    const outbox = await repo.claimOutbox({
      leaseOwner: 'test-worker',
      leaseToken: 'token-outbox',
      leaseDurationMs: 10_000,
    });
    expect(outbox.some(o => o.kind === 'assistant_run' && (o.payload as any).runId === body.runId)).toBe(true);

    const retryRes = await handlers.sendMessage(OWNER, WS, 'req-msg-1', {
      id: body.message.id,
      parts: [{ type: 'text', text: 'Rename to Global Retro' }],
    });
    expect(retryRes.status).toBe(202);
    expect((retryRes.body as any).runId).toBe(body.runId);
  });

  it('2. Simultaneous /run requests do not duplicate runs or execution lanes', async () => {
    const { repo, handlers } = await createFixture();

    const [res1, res2] = await Promise.all([
      handlers.runAssistant(OWNER, WS),
      handlers.runAssistant(OWNER, WS),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const run1 = (res1.body as any).run;
    const run2 = (res2.body as any).run;
    expect(run1.id).toBe(run2.id);

    const runs = await Promise.all([
      repo.getRun({ runId: run1.id, workspaceId: WS }),
    ]);
    expect(runs[0]?.status).toBe('queued');
  });

  it('3. Multiple workers cannot own the same run; expired worker loses lease', async () => {
    const { repo, handlers } = await createFixture();
    await handlers.sendMessage(OWNER, WS, undefined, {
      id: crypto.randomUUID(),
      parts: [{ type: 'text', text: 'Do work' }],
    });

    const run1 = await repo.claimRun({
      workspaceId: WS,
      leaseOwner: 'worker-A',
      leaseToken: 'token-A',
      leaseDurationMs: 100,
    });
    expect(run1).not.toBeNull();
    expect(run1?.leaseOwner).toBe('worker-A');

    const run2 = await repo.claimRun({
      workspaceId: WS,
      leaseOwner: 'worker-B',
      leaseToken: 'token-B',
      leaseDurationMs: 100,
    });
    expect(run2).toBeNull();

    await new Promise(r => setTimeout(r, 120));

    const run3 = await repo.claimRun({
      workspaceId: WS,
      leaseOwner: 'worker-B',
      leaseToken: 'token-B',
      leaseDurationMs: 100,
      now: new Date(Date.now() + 200),
    });
    expect(run3).not.toBeNull();
    expect(run3?.leaseOwner).toBe('worker-B');
    expect(run3?.fence).toBe(2);
  });

  it('4. Expired and canceled workers cannot commit', async () => {
    const { repo, handlers } = await createFixture();
    await handlers.sendMessage(OWNER, WS, undefined, {
      id: crypto.randomUUID(),
      parts: [{ type: 'text', text: 'Update title' }],
    });

    const run = await repo.claimRun({
      workspaceId: WS,
      leaseOwner: 'worker-A',
      leaseToken: 'token-A',
      leaseDurationMs: 50,
    });

    await handlers.cancelRun(OWNER, WS, run!.id, { reason: 'User cancelled' });

    const tools = createAgendaAiTools({
      workspaceId: WS,
      ownerId: OWNER,
      repo,
      domain: agendaDomain,
      observedRevision: 0,
      runFence: { runId: run!.id, leaseToken: 'token-A' },
    });

    await expect(
      (tools.set_meeting_title as any).execute({ title: 'New Title' })
    ).rejects.toThrow('RUN_CANCELED');
  });

  it('5. Worker restart after tool commit does not repeat mutation', async () => {
    const { repo, handlers } = await createFixture();
    await handlers.sendMessage(OWNER, WS, undefined, {
      id: crypto.randomUUID(),
      parts: [{ type: 'text', text: 'Rename title to All Hands' }],
    });

    const run = await repo.claimRun({
      workspaceId: WS,
      leaseOwner: 'worker-1',
      leaseToken: 'token-1',
      leaseDurationMs: 60_000,
    });

    let toolCallCount = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        toolCallCount += 1;
        if (toolCallCount === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'set_meeting_title',
                input: JSON.stringify({ title: 'All Hands' }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage: defaultUsage,
            warnings: [],
          };
        }
        throw new Error('SIMULATED_CRASH');
      },
    });

    await expect(
      runAssistantTurn({
        workspaceId: WS,
        ownerId: OWNER,
        repo,
        domain: agendaDomain,
        model: createAiSdkModelAdapter(model),
        createTools: createAgendaAiTools,
        runId: run!.id,
        leaseToken: 'token-1',
      })
    ).rejects.toThrow('SIMULATED_CRASH');

    const steps = await repo.listSteps({ runId: run!.id });
    expect(steps.some(s => s.toolName === 'set_meeting_title' && s.state === 'completed')).toBe(true);
    const wsMid = await repo.loadWorkspace<AgendaWorkspace>({ workspaceId: WS, ownerId: OWNER });
    expect(wsMid?.revision).toBe(1);

    const restartModel = new MockLanguageModelV4({
      doGenerate: async () => {
        return {
          content: [{ type: 'text', text: 'All done.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: defaultUsage,
          warnings: [],
        };
      },
    });

    const res = await runAssistantTurn({
      workspaceId: WS,
      ownerId: OWNER,
      repo,
      domain: agendaDomain,
      model: createAiSdkModelAdapter(restartModel),
      createTools: createAgendaAiTools,
      runId: run!.id,
      leaseToken: 'token-1',
      observedRevision: 0,
    });

    expect(res.success).toBe(true);
    const wsFinal = await repo.loadWorkspace<AgendaWorkspace>({ workspaceId: WS, ownerId: OWNER });
    expect(wsFinal?.revision).toBe(1);
    expect(wsFinal?.snapshot.meetingTitle).toBe('All Hands');
  });

  it('6. Direct UI edit while model is running causes STALE_WORKSPACE rejection', async () => {
    const { repo, handlers } = await createFixture();
    await handlers.sendMessage(OWNER, WS, undefined, {
      id: crypto.randomUUID(),
      parts: [{ type: 'text', text: 'Rename meeting' }],
    });

    const run = await repo.claimRun({
      workspaceId: WS,
      leaseOwner: 'worker-1',
      leaseToken: 'token-1',
      leaseDurationMs: 60_000,
    });

    // User edits UI in browser
    await repo.commitAction({
      workspaceId: WS,
      ownerId: OWNER,
      expectedRevision: 0,
      envelope: {
        actionId: crypto.randomUUID(),
        workspaceId: WS,
        expectedRevision: 0,
        entityVersions: [],
        action: { type: 'set_meeting_title', title: 'Manual Title Edit' },
      },
      plan: agendaDomain.plan,
    });

    const tools = createAgendaAiTools({
      workspaceId: WS,
      ownerId: OWNER,
      repo,
      domain: agendaDomain,
      observedRevision: 0,
      runFence: { runId: run!.id, leaseToken: 'token-1' },
    });

    await expect(
      (tools.set_meeting_title as any).execute({ title: 'Model Title' })
    ).rejects.toThrow('STALE_WORKSPACE');
  });

  it('7. Proposals lifecycle and state transitions', async () => {
    const { repo, handlers } = await createFixture();

    const proposal = await repo.createProposal({
      workspaceId: WS,
      ownerId: OWNER,
      actionPayload: { type: 'set_meeting_title', title: 'Executive Sync' },
      summary: 'Propose changing meeting title to Executive Sync',
    });

    expect(proposal.state).toBe('pending');

    const listRes = await handlers.listProposals(OWNER, WS);
    expect(listRes.status).toBe(200);
    expect((listRes.body as any).proposals).toHaveLength(1);

    const decideRes = await handlers.decideProposal(OWNER, WS, proposal.id, { decision: 'accepted' });
    expect(decideRes.status).toBe(200);
    expect((decideRes.body as any).proposal.state).toBe('accepted');

    const secondDecide = await handlers.decideProposal(OWNER, WS, proposal.id, { decision: 'rejected' });
    expect(secondDecide.status).toBe(409);
  });
});
