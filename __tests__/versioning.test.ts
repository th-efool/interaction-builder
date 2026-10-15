import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  PACKAGE_VERSION,
  isSupportedProtocolVersion,
  interactionEventSchema,
} from '../src/core/contracts';
import { createInteractionHandlers, type DomainDefinition } from '../src/runtime/handlers';
import { MemoryInteractionRepository } from '../src/runtime/memory.repository';
import { runAssistantTurn, type InteractionModelAdapter } from '../src/runtime/runner';

describe('Version and Upgrade Contracts', () => {
  it('exposes protocol and package versions cleanly', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(PACKAGE_VERSION).toBe('0.1.0');
    expect(isSupportedProtocolVersion(1)).toBe(true);
    expect(isSupportedProtocolVersion(0)).toBe(false);
    expect(isSupportedProtocolVersion(2)).toBe(false);

    // Event schema validation
    const validEvent = {
      protocolVersion: 1,
      eventId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sequence: 1,
      type: 'workspace.committed',
      revision: 1,
      payload: {},
    };
    expect(interactionEventSchema.safeParse(validEvent).success).toBe(true);

    const invalidEvent = {
      ...validEvent,
      protocolVersion: 2, // Unsupported future protocol
    };
    expect(interactionEventSchema.safeParse(invalidEvent).success).toBe(false);
  });

  it('rejects action commits against unsupported workspace domain versions', async () => {
    const repo = new MemoryInteractionRepository();
    const domainV1: DomainDefinition<any> = {
      id: 'doc',
      version: 1,
      initialState: () => ({ text: 'initial' }),
      plan: (state, action: any) => ({
        nextState: { ...state, text: action.text },
        changed: [],
        invalidated: [],
        summary: 'updated',
        undoable: false,
      }),
    };

    const handlers = createInteractionHandlers({
      repo,
      domains: new Map([['doc', domainV1]]),
    });

    const ownerId = 'user-1';
    const workspaceId = crypto.randomUUID();

    // Directly create workspace with domainVersion 2 in storage (e.g. created by a newer node)
    await repo.createWorkspace({
      id: workspaceId,
      ownerId,
      domainId: 'doc',
      domainVersion: 2,
      initialSnapshot: { text: 'initial v2' },
    });

    // Attempting action commit from a v1-only handler must fail with UNSUPPORTED_DOMAIN_VERSION
    const res = await handlers.commitAction(ownerId, crypto.randomUUID(), {
      actionId: crypto.randomUUID(),
      workspaceId,
      expectedRevision: 0,
      entityVersions: [],
      action: { type: 'set_text', text: 'new text' },
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'UNSUPPORTED_DOMAIN_VERSION',
      retryable: false,
    });

    // Upgrading the domain definition to support both version 1 and 2 allows commit
    const domainV2WithBackCompat: DomainDefinition<any> = {
      ...domainV1,
      version: 2,
      supportsVersion: (v) => v === 1 || v === 2,
    };

    const upgradedHandlers = createInteractionHandlers({
      repo,
      domains: new Map([['doc', domainV2WithBackCompat]]),
    });

    const res2 = await upgradedHandlers.commitAction(ownerId, crypto.randomUUID(), {
      actionId: crypto.randomUUID(),
      workspaceId,
      expectedRevision: 0,
      entityVersions: [],
      action: { type: 'set_text', text: 'new text' },
    });

    expect(res2.status).toBe(200);
    expect((res2.body as any).revision).toBe(1);
    expect((res2.body as any).snapshot).toEqual({ text: 'new text' });
  });

  it('enforces domain matching and version compatibility in runAssistantTurn', async () => {
    const repo = new MemoryInteractionRepository();
    const ownerId = 'user-1';
    const workspaceId = crypto.randomUUID();

    await repo.createWorkspace({
      id: workspaceId,
      ownerId,
      domainId: 'agenda',
      domainVersion: 2,
      initialSnapshot: { items: [] },
    });

    await repo.appendMessage({
      workspaceId,
      ownerId,
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    });

    const mockModel: InteractionModelAdapter = {
      async executeTurn() {
        return { text: 'Assistant reply', stepsCount: 0 };
      },
    };

    // Case 1: Domain mismatch
    const otherDomain: DomainDefinition<any> = {
      id: 'other_domain',
      version: 2,
      initialState: () => ({}),
      plan: () => ({} as any),
    };

    await expect(
      runAssistantTurn({
        workspaceId,
        ownerId,
        repo,
        domain: otherDomain,
        model: mockModel,
        createTools: () => ({}),
      })
    ).rejects.toThrow('DOMAIN_MISMATCH');

    // Case 2: Domain matches but version is unsupported
    const agendaV1: DomainDefinition<any> = {
      id: 'agenda',
      version: 1, // Only supports 1
      initialState: () => ({}),
      plan: () => ({} as any),
    };

    await expect(
      runAssistantTurn({
        workspaceId,
        ownerId,
        repo,
        domain: agendaV1,
        model: mockModel,
        createTools: () => ({}),
      })
    ).rejects.toThrow('UNSUPPORTED_DOMAIN_VERSION');

    // Case 3: Domain supports version 2 -> succeeds
    const agendaV2: DomainDefinition<any> = {
      id: 'agenda',
      version: 2,
      initialState: () => ({}),
      plan: () => ({} as any),
    };

    const res = await runAssistantTurn({
      workspaceId,
      ownerId,
      repo,
      domain: agendaV2,
      model: mockModel,
      createTools: () => ({}),
    });

    expect(res.success).toBe(true);
    expect(res.text).toBe('Assistant reply');
  });

  it('enforces worker domain and version filtering during claimRun', async () => {
    const repo = new MemoryInteractionRepository();
    const ownerId = 'user-1';

    // Workspace A: domain "agenda", domainVersion 1
    const wsA = crypto.randomUUID();
    await repo.createWorkspace({
      id: wsA,
      ownerId,
      domainId: 'agenda',
      domainVersion: 1,
      initialSnapshot: {},
    });
    const runA = await repo.scheduleRun({ workspaceId: wsA, ownerId });

    // Workspace B: domain "agenda", domainVersion 2
    const wsB = crypto.randomUUID();
    await repo.createWorkspace({
      id: wsB,
      ownerId,
      domainId: 'agenda',
      domainVersion: 2,
      initialSnapshot: {},
    });
    const runB = await repo.scheduleRun({ workspaceId: wsB, ownerId });

    // Worker 1: Legacy worker supporting ONLY domainVersion 1
    const claimWorker1 = await repo.claimRun({
      leaseOwner: 'worker-v1',
      leaseToken: 'token-1',
      leaseDurationMs: 30000,
      supportedDomainVersions: [1],
    });

    expect(claimWorker1).not.toBeNull();
    expect(claimWorker1?.id).toBe(runA.id);
    expect(claimWorker1?.workspaceId).toBe(wsA);

    // Second claim from Worker 1 should return NULL because remaining runB is domainVersion 2
    const claimWorker1Second = await repo.claimRun({
      leaseOwner: 'worker-v1',
      leaseToken: 'token-1b',
      leaseDurationMs: 30000,
      supportedDomainVersions: [1],
    });
    expect(claimWorker1Second).toBeNull();

    // Worker 2: Upgraded worker supporting domainVersion 2
    const claimWorker2 = await repo.claimRun({
      leaseOwner: 'worker-v2',
      leaseToken: 'token-2',
      leaseDurationMs: 30000,
      supportedDomainVersions: [2],
    });
    expect(claimWorker2).not.toBeNull();
    expect(claimWorker2?.id).toBe(runB.id);
    expect(claimWorker2?.workspaceId).toBe(wsB);
  });
});
