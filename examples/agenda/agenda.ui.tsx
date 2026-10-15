import React, { useState } from 'react';
import {
  InteractionProvider,
  useWorkspaceView,
  useWorkspaceMessages,
  useSendMessage,
  useDispatchAction,
  useWorkspaceConnection,
  useWorkspacePending,
  useInteractionHistory,
} from 'interaction-builder/react';
import type { AgendaWorkspace, AgendaAction } from './agenda.domain';
import type { EntityRef } from 'interaction-builder/core';

export function AgendaViewer({
  selectedItemId,
  onSelectItem,
}: {
  selectedItemId?: string | null;
  onSelectItem?: (id: string | null) => void;
}) {
  const agenda = useWorkspaceView<AgendaWorkspace>();
  const dispatchAction = useDispatchAction<AgendaAction>();
  const connection = useWorkspaceConnection();
  const pending = useWorkspacePending();
  const history = useInteractionHistory<AgendaWorkspace>();
  const [newTitle, setNewTitle] = useState('');
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  const handleAction = async (action: AgendaAction, entityVersions?: EntityRef[]) => {
    setConflictNotice(null);
    const ok = await dispatchAction(action, entityVersions);
    if (!ok) {
      setConflictNotice('Action conflict detected (stale workspace or entity). State refreshed.');
    }
  };

  return (
    <div className="agenda-viewer" data-testid="agenda-viewer">
      <div className="viewer-header">
        <h1 data-testid="meeting-title">{agenda.meetingTitle}</h1>
        <div className="status-badges">
          <span className={`badge-connection ${connection}`} data-testid="connection-status">
            Status: {connection}
          </span>
          {Object.keys(pending).length > 0 && (
            <span className="badge-pending" data-testid="pending-status">
              Saving {Object.keys(pending).length} change(s)...
            </span>
          )}
        </div>
      </div>

      <p data-testid="meeting-date">Date: {agenda.date}</p>

      {conflictNotice && (
        <div className="conflict-banner" data-testid="conflict-banner" role="alert">
          {conflictNotice}
        </div>
      )}

      <div className="history-toolbar" data-testid="history-toolbar">
        <button
          onClick={() => history.undo()}
          disabled={!history.canUndo}
          data-testid="undo-button"
        >
          Undo
        </button>
        <button
          onClick={() => history.redo()}
          disabled={!history.canRedo}
          data-testid="redo-button"
        >
          Redo
        </button>
        <span data-testid="active-revision">Rev: {history.activeRevision}</span>
      </div>

      <ul data-testid="items-list" className="items-list">
        {agenda.items.map(item => {
          const isSelected = selectedItemId === item.id;
          return (
            <li
              key={item.id}
              data-testid={`item-${item.id}`}
              className={`agenda-item ${isSelected ? 'selected' : ''}`}
              onClick={() => onSelectItem?.(isSelected ? null : item.id)}
            >
              <div
                className="item-details"
                data-testid={`item-details-${item.id}`}
                onClick={() => onSelectItem?.(isSelected ? null : item.id)}
              >
                <span className="item-title" data-testid={`item-title-${item.id}`}>
                  {item.title} ({item.durationMinutes}m) - {item.presenter} {item.pinned ? '[PINNED]' : ''}
                </span>
                {isSelected && <span className="selection-chip" data-testid="selected-indicator">Selected for context</span>}
              </div>
              <div className="item-actions" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() =>
                    handleAction(
                      { type: 'set_item_pin', itemId: item.id, pinned: !item.pinned },
                      [{ kind: 'agenda_item', id: item.id, version: item.version }]
                    )
                  }
                  data-testid={`pin-btn-${item.id}`}
                >
                  {item.pinned ? 'Unpin' : 'Pin'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="title-form">
        <input
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          placeholder="New meeting title"
          data-testid="title-input"
        />
        <button
          onClick={() => {
            if (newTitle.trim()) {
              void handleAction({ type: 'set_meeting_title', title: newTitle.trim() });
              setNewTitle('');
            }
          }}
          data-testid="update-title-button"
        >
          Update Title
        </button>
      </div>
    </div>
  );
}

export function AgendaChat({
  selectedItemId,
  onClearSelection,
}: {
  selectedItemId?: string | null;
  onClearSelection?: () => void;
}) {
  const agenda = useWorkspaceView<AgendaWorkspace>();
  const messages = useWorkspaceMessages();
  const sendMessage = useSendMessage();
  const [text, setText] = useState('');

  const selectedItem = selectedItemId ? agenda.items.find(i => i.id === selectedItemId) : null;

  return (
    <div className="agenda-chat" data-testid="agenda-chat">
      <div className="messages" data-testid="messages-container">
        {messages.map(m => (
          <div key={m.id} className={`message message-${m.role}`} data-testid={`message-${m.id}`}>
            <span className="message-role">{m.role}:</span>
            <div className="message-parts">
              {m.parts.map((p: any, i: number) => {
                if (p.type === 'text') return <span key={i}>{p.text}</span>;
                if (p.type === 'entity_ref') {
                  return (
                    <span key={i} className="message-entity-ref" data-testid="entity-ref-chip">
                      @{p.label}
                    </span>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-composer">
        {selectedItem && (
          <div className="selection-target-bar" data-testid="chat-selection-chip">
            <span>Referencing: <strong>{selectedItem.title}</strong></span>
            <button type="button" onClick={() => onClearSelection?.()}>×</button>
          </div>
        )}
        <div className="composer-row">
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={selectedItem ? `Ask about ${selectedItem.title}...` : 'Type a message or instruction...'}
            data-testid="chat-input"
            onKeyDown={e => {
              if (e.key === 'Enter' && text.trim()) {
                const entityRefs = selectedItem
                  ? [{ entity: { kind: 'agenda_item', id: selectedItem.id, version: selectedItem.version }, label: selectedItem.title }]
                  : undefined;
                void sendMessage(text.trim(), entityRefs);
                setText('');
              }
            }}
          />
          <button
            onClick={() => {
              if (text.trim()) {
                const entityRefs = selectedItem
                  ? [{ entity: { kind: 'agenda_item', id: selectedItem.id, version: selectedItem.version }, label: selectedItem.title }]
                  : undefined;
                void sendMessage(text.trim(), entityRefs);
                setText('');
              }
            }}
            data-testid="chat-send-button"
          >
            Send
          </button>
        </div>
      </div>
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
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  return (
    <InteractionProvider workspaceId={workspaceId} initialView={initialAgenda} transport={transport}>
      <div className="agenda-app" data-testid="agenda-app">
        <AgendaViewer
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
        />
        <AgendaChat
          selectedItemId={selectedItemId}
          onClearSelection={() => setSelectedItemId(null)}
        />
      </div>
    </InteractionProvider>
  );
}
