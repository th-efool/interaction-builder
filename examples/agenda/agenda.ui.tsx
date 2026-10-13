import React, { useState } from 'react';
import {
  InteractionProvider,
  useWorkspaceView,
  useWorkspaceMessages,
  useSendMessage,
  useDispatchAction,
} from 'interaction-builder/react';
import type { AgendaWorkspace, AgendaAction } from './agenda.domain';

export function AgendaViewer() {
  const agenda = useWorkspaceView<AgendaWorkspace>();
  const dispatchAction = useDispatchAction<AgendaAction>();
  const [newTitle, setNewTitle] = useState('');

  return (
    <div className="agenda-viewer">
      <h1 data-testid="meeting-title">{agenda.meetingTitle}</h1>
      <p data-testid="meeting-date">Date: {agenda.date}</p>
      <ul data-testid="items-list">
        {agenda.items.map(item => (
          <li key={item.id} data-testid={`item-${item.id}`}>
            <span>
              {item.title} ({item.durationMinutes}m) - {item.presenter} {item.pinned ? '[PINNED]' : ''}
            </span>
            <button
              onClick={() =>
                dispatchAction({ type: 'set_item_pin', itemId: item.id, pinned: !item.pinned })
              }
            >
              {item.pinned ? 'Unpin' : 'Pin'}
            </button>
          </li>
        ))}
      </ul>
      <div className="title-form">
        <input
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          placeholder="New meeting title"
        />
        <button
          onClick={() => {
            if (newTitle) {
              dispatchAction({ type: 'set_meeting_title', title: newTitle });
              setNewTitle('');
            }
          }}
        >
          Update Title
        </button>
      </div>
    </div>
  );
}

export function AgendaChat() {
  const messages = useWorkspaceMessages();
  const sendMessage = useSendMessage();
  const [text, setText] = useState('');

  return (
    <div className="agenda-chat">
      <div className="messages" data-testid="messages-container">
        {messages.map(m => (
          <div key={m.id} className={`message-${m.role}`}>
            {m.parts.map((p: any, i: number) => (
              <span key={i}>{p.type === 'text' ? p.text : ''}</span>
            ))}
          </div>
        ))}
      </div>
      <input value={text} onChange={e => setText(e.target.value)} />
      <button
        onClick={() => {
          if (text) {
            void sendMessage(text);
            setText('');
          }
        }}
      >
        Send
      </button>
    </div>
  );
}

export function AgendaApp({
  workspaceId,
  initialAgenda,
  transport,
}: {
  workspaceId: string;
  initialAgenda: AgendaWorkspace;
  transport?: any;
}) {
  return (
    <InteractionProvider workspaceId={workspaceId} initialView={initialAgenda} transport={transport}>
      <div className="agenda-app">
        <AgendaViewer />
        <AgendaChat />
      </div>
    </InteractionProvider>
  );
}
