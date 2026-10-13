import React from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryInteractionRepository, runAssistantTurn } from 'interaction-builder/runtime';
import { createScriptedModelAdapter } from 'interaction-builder/testkit';
import { agendaDomain, type AgendaWorkspace } from './agenda.domain';
import { createAgendaAiTools } from './agenda.tools';
import { AgendaApp } from './agenda.ui';

export async function runAgendaExample() {
  console.log('--- Running Standalone Agenda Example ---');
  const repo = createMemoryInteractionRepository();
  const workspaceId = crypto.randomUUID();
  const ownerId = 'user-agenda-1';

  const initialAgenda: AgendaWorkspace = {
    schemaVersion: 1,
    meetingTitle: 'Weekly Sync',
    date: '2026-10-15',
    items: [
      {
        id: 'item-1',
        version: 0,
        title: 'Architecture Review',
        durationMinutes: 15,
        presenter: 'Alice',
        pinned: false,
      },
      {
        id: 'item-2',
        version: 0,
        title: 'Roadmap Planning',
        durationMinutes: 20,
        presenter: 'Bob',
        pinned: false,
      },
    ],
  };

  // 1. Create workspace
  const ws = await repo.createWorkspace({
    id: workspaceId,
    ownerId,
    domainId: 'agenda',
    domainVersion: 1,
    initialSnapshot: initialAgenda,
  });
  console.log(`[1] Created workspace "${ws.snapshot.meetingTitle}" at revision ${ws.revision}`);

  // 2. User submits message in chat
  await repo.appendMessage({
    workspaceId,
    ownerId,
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: 'Rename meeting to Q4 Strategy & Architecture, and set Architecture Review to 40 minutes.' }],
  });
  console.log('[2] Appended user message to transcript');

  // 3. Schedule and claim run with lease
  const run = await repo.scheduleRun({ workspaceId, ownerId });
  const leaseToken = crypto.randomUUID();
  const claimed = await repo.claimRun({
    workspaceId,
    leaseOwner: 'agenda-worker-1',
    leaseToken,
    leaseDurationMs: 30_000,
  });
  const activeRun = claimed ?? run;
  const token = claimed ? leaseToken : (activeRun.leaseToken ?? leaseToken);

  // 4. Scripted mock model calling two tools
  const model = createScriptedModelAdapter([
    {
      toolCalls: [
        {
          toolName: 'set_meeting_title',
          input: { title: 'Q4 Strategy & Architecture' },
        },
      ],
    },
    {
      toolCalls: [
        {
          toolName: 'edit_item',
          input: { itemId: 'item-1', durationMinutes: 40 },
        },
      ],
    },
    {
      text: 'I have updated the meeting title to "Q4 Strategy & Architecture" and increased Architecture Review duration to 40 minutes.',
    },
  ]);

  const res = await runAssistantTurn({
    workspaceId,
    ownerId,
    repo,
    domain: agendaDomain,
    model,
    createTools: createAgendaAiTools,
    runId: activeRun.id,
    leaseToken: token,
  });

  await repo.completeRun({
    runId: activeRun.id,
    leaseToken: token,
    assistantMessageId: res.assistantMessageId,
  });

  console.log(`[3] Assistant turn finished. Response: "${res.text}"`);

  // 5. Inspect final workspace
  const updatedWs = await repo.loadWorkspace<AgendaWorkspace>({ workspaceId, ownerId });
  console.log(`[4] Current revision: ${updatedWs?.revision}`);
  console.log(`    Meeting Title: "${updatedWs?.snapshot.meetingTitle}"`);
  console.log(`    Item 1 duration: ${updatedWs?.snapshot.items[0]?.durationMinutes} min`);

  // 6. Direct UI user action (pinning item-1)
  await repo.commitAction({
    workspaceId,
    ownerId,
    expectedRevision: updatedWs!.revision,
    envelope: {
      actionId: crypto.randomUUID(),
      workspaceId,
      expectedRevision: updatedWs!.revision,
      entityVersions: [{ kind: 'agenda_item', id: 'item-1', version: updatedWs!.snapshot.items[0].version }],
      action: { type: 'set_item_pin', itemId: 'item-1', pinned: true },
    },
    plan: agendaDomain.plan,
  });

  const finalWs = await repo.loadWorkspace<AgendaWorkspace>({ workspaceId, ownerId });
  console.log(`[5] Direct user action applied: Item 1 pinned = ${finalWs?.snapshot.items[0]?.pinned}. Revision: ${finalWs?.revision}`);

  // 7. Mount AgendaApp (chat + agenda UI) to verify React consumer mounting
  const html = renderToString(
    React.createElement(AgendaApp, {
      workspaceId,
      initialAgenda: finalWs!.snapshot,
    })
  );
  console.log(`[6] Mounted AgendaApp chat + agenda UI successfully (${html.length} chars rendered)`);
  console.log('--- Agenda Example Succeeded ---');
  return finalWs;
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  void runAgendaExample().catch(err => {
    console.error('Agenda example error:', err);
    process.exit(1);
  });
}
