// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgendaApp } from '../examples/agenda/agenda.ui';
import type { AgendaWorkspace, AgendaAction } from '../examples/agenda/agenda.domain';
import type { InteractionTransport } from '../src/client/store';

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

function createFakeAgendaTransport(init: AgendaWorkspace) {
  let currentSnapshot = structuredClone(init);
  let revision = 0;
  let cursor = 0;
  const committedActions: unknown[] = [];
  const sentMessages: string[] = [];

  const transport: InteractionTransport<AgendaWorkspace> = {
    getWorkspace: async () => ({
      workspaceId: 'agenda-ws-1',
      revision,
      cursor,
      snapshot: structuredClone(currentSnapshot),
    }),
    commit: async (envelope: any) => {
      committedActions.push(envelope.action);
      revision += 1;
      cursor += 1;

      // Apply action to snapshot
      const action = envelope.action as AgendaAction;
      if (action.type === 'set_item_pin') {
        const item = currentSnapshot.items.find(i => i.id === action.itemId);
        if (item) {
          item.pinned = action.pinned;
          item.version += 1;
        }
      } else if (action.type === 'set_meeting_title') {
        currentSnapshot.meetingTitle = action.title;
      }

      return {
        revision,
        cursor,
        snapshot: structuredClone(currentSnapshot),
        receipt: { receiptId: crypto.randomUUID(), summary: 'Action committed' },
      };
    },
    openEvents: (_cursor, _onEvent, _onClose) => {
      return () => undefined;
    },
    sendMessage: async (payload: { id: string; parts: unknown[] }, _idempotencyKey?: string) => {
      const text = (payload.parts?.[0] as any)?.text ?? String(payload);
      sentMessages.push(text);
      cursor += 1;
      return {
        message: payload,
        cursor,
      };
    },
  };

  return { transport, committedActions, sentMessages, getSnapshot: () => currentSnapshot };
}

describe('AgendaApp Interactive UI (Component Testing without Prod Credentials)', () => {
  it('renders initial state and supports interactive button clicks, form inputs, and chat submission', async () => {
    const fake = createFakeAgendaTransport(initialAgenda);

    render(
      <AgendaApp
        workspaceId="agenda-ws-1"
        initialAgenda={initialAgenda}
        transport={fake.transport}
      />
    );

    // 1. Initial DOM checks (verifies real interactive DOM, not merely renderToString)
    expect(screen.getByTestId('meeting-title').textContent).toBe('Weekly Sync');
    expect(screen.getByTestId('item-item-1').textContent).toContain('Architecture Review');
    expect(screen.getByTestId('item-item-2').textContent).toContain('Roadmap Planning');

    // 2. Interactive button click: Pin item-1
    const pinButtons = screen.getAllByRole('button', { name: /pin/i });
    await act(async () => {
      fireEvent.click(pinButtons[0]);
    });

    expect(fake.committedActions).toHaveLength(1);
    expect(fake.committedActions[0]).toEqual({
      type: 'set_item_pin',
      itemId: 'item-1',
      pinned: true,
    });
    expect(screen.getByTestId('item-item-1').textContent).toContain('[PINNED]');

    // 3. Interactive text input + form submit: Update Meeting Title
    const titleInput = screen.getByPlaceholderText('New meeting title');
    const updateButton = screen.getByRole('button', { name: /update title/i });

    await act(async () => {
      fireEvent.change(titleInput, { target: { value: '2026 Executive Roadmap' } });
      fireEvent.click(updateButton);
    });

    expect(fake.committedActions).toHaveLength(2);
    expect(fake.committedActions[1]).toEqual({
      type: 'set_meeting_title',
      title: '2026 Executive Roadmap',
    });
    expect(screen.getByTestId('meeting-title').textContent).toBe('2026 Executive Roadmap');

    // 4. Interactive chat: submit message
    const sendButton = screen.getByRole('button', { name: /send/i });
    const chatInputs = screen.getAllByRole('textbox');
    const chatInput = chatInputs[chatInputs.length - 1]; // chat input is second textbox

    await act(async () => {
      fireEvent.change(chatInput, { target: { value: 'Please adjust timing for roadmap review.' } });
      fireEvent.click(sendButton);
    });

    expect(fake.sentMessages).toContain('Please adjust timing for roadmap review.');
  });
});
