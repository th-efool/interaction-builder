import { describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { createInteractionStore } from '../src/client/store';
import { InteractionProvider } from '../src/react/provider';
import { useInteractionSelector, useInteractionHistory, useIsCrossTabLeader } from '../src/react/hooks';

describe('useInteractionSelector & Render Optimization', () => {
  it('selects fine-grained state slices correctly in React', () => {
    const store = createInteractionStore({
      workspaceId: '550e8400-e29b-41d4-a716-446655440001',
      initialView: {
        user: { name: 'Alice', age: 30 },
        settings: { theme: 'dark' },
      },
      transport: {
        getWorkspace: async () => ({
          workspaceId: '550e8400-e29b-41d4-a716-446655440001',
          domainId: 'demo',
          domainVersion: 1,
          revision: 1,
          sequence: 1,
          view: { user: { name: 'Alice', age: 30 }, settings: { theme: 'dark' } },
          messages: [],
        }),
        commit: async () => ({
          revision: 2,
          sequence: 2,
          receipt: {} as any,
          view: { user: { name: 'Alice', age: 31 }, settings: { theme: 'dark' } },
        }),
        sendMessage: async () => ({ sequence: 2, message: {} as any }),
        runAssistant: async () => ({ success: true }),
        openEvents: () => () => {},
      },
    });

    function UserName() {
      const name = useInteractionSelector(
        (v: { user: { name: string; age: number }; settings: { theme: string } }) => v.user.name
      );
      return <span id="user-name">{name}</span>;
    }

    const html = renderToString(
      <InteractionProvider store={store}>
        <UserName />
      </InteractionProvider>
    );

    expect(html).toContain('Alice');
  });

  it('handles optional undefined slices without bypassing equality check', () => {
    const store = createInteractionStore({
      workspaceId: '550e8400-e29b-41d4-a716-446655440001',
      initialView: {
        item: undefined as string | undefined,
      },
      transport: {
        getWorkspace: async () => ({
          workspaceId: '550e8400-e29b-41d4-a716-446655440001',
          domainId: 'demo',
          domainVersion: 1,
          revision: 1,
          sequence: 1,
          view: { item: undefined },
          messages: [],
        }),
        commit: async () => ({} as any),
        openEvents: () => () => {},
      },
    });

    function OptionalItem() {
      const item = useInteractionSelector((v: { item?: string }) => v.item);
      return <span>{item === undefined ? 'empty' : item}</span>;
    }

    const html = renderToString(
      <InteractionProvider store={store}>
        <OptionalItem />
      </InteractionProvider>
    );

    expect(html).toContain('empty');
  });

  it('renders with useInteractionHistory and useIsCrossTabLeader hooks', () => {
    const store = createInteractionStore({
      workspaceId: '550e8400-e29b-41d4-a716-446655440001',
      initialView: { title: 'App' },
      enableHistory: true,
      transport: {
        getWorkspace: async () => ({
          workspaceId: '550e8400-e29b-41d4-a716-446655440001',
          revision: 0,
          cursor: 0,
          snapshot: { title: 'App' },
          messages: [],
        }),
        commit: async () => ({} as any),
        openEvents: () => () => {},
      },
    });

    function HistoryToolbar() {
      const { canUndo, canRedo, isTimeTraveling } = useInteractionHistory();
      const isLeader = useIsCrossTabLeader();
      return (
        <div>
          <span>{`undo:${canUndo ? 'yes' : 'no'}`}</span>
          <span>{`redo:${canRedo ? 'yes' : 'no'}`}</span>
          <span>{`tt:${isTimeTraveling ? 'yes' : 'no'}`}</span>
          <span>{`leader:${isLeader ? 'yes' : 'no'}`}</span>
        </div>
      );
    }

    const html = renderToString(
      <InteractionProvider store={store}>
        <HistoryToolbar />
      </InteractionProvider>
    );

    expect(html).toContain('undo:no');
    expect(html).toContain('redo:no');
    expect(html).toContain('tt:no');
    expect(html).toContain('leader:yes');
  });
});

