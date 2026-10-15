import React, { useState, useEffect } from 'react';
import {
  InteractionProvider,
  useWorkspaceView,
  useWorkspaceMessages,
  useSendMessage,
  useDispatchAction,
  useWorkspaceConnection,
} from 'interaction-builder/react';
import type { HostAgendaMeeting, HostAgendaCommand, HostBoundAgendaWorkspace, HostBoundAgendaAction } from './host-agenda.domain';
import { AgendaChat } from './agenda.ui';

export interface HostAgendaViewerProps {
  meeting: HostAgendaMeeting;
  selectedItemId?: string | null;
  onSelectItem?: (id: string | null) => void;
  onExecuteCommand: (command: HostAgendaCommand, expectedVersion: number) => Promise<{ ok: boolean; error?: string }>;
  onRefreshMeeting?: () => Promise<void>;
}

export function HostAgendaViewer({
  meeting,
  selectedItemId,
  onSelectItem,
  onExecuteCommand,
  onRefreshMeeting,
}: HostAgendaViewerProps) {
  const [newTitle, setNewTitle] = useState('');
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCommand = async (command: HostAgendaCommand) => {
    setConflictNotice(null);
    setIsSubmitting(true);
    try {
      const res = await onExecuteCommand(command, meeting.version);
      if (!res.ok) {
        setConflictNotice(res.error || 'Host command conflict detected (stale resource version).');
        if (onRefreshMeeting) await onRefreshMeeting();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="host-agenda-viewer" data-testid="host-agenda-viewer">
      <div className="viewer-header">
        <div className="authoritative-badge" data-testid="host-authoritative-badge" style={{ fontSize: '0.8rem', color: '#16a34a', fontWeight: 'bold' }}>
          Authoritative Host Record (Version {meeting.version})
        </div>
        <h1 data-testid="meeting-title">{meeting.meetingTitle}</h1>
        <p className="meeting-date" data-testid="meeting-date">Date: {meeting.date}</p>

        {conflictNotice && (
          <div className="conflict-banner" data-testid="host-conflict-banner" style={{ background: '#fee2e2', color: '#991b1b', padding: '0.5rem', borderRadius: '4px', marginBottom: '1rem' }}>
            {conflictNotice}
          </div>
        )}

        <form
          className="title-form"
          onSubmit={e => {
            e.preventDefault();
            if (newTitle.trim()) {
              void handleCommand({ type: 'set_meeting_title', title: newTitle.trim() });
              setNewTitle('');
            }
          }}
        >
          <input
            type="text"
            placeholder="Change title via host command..."
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            disabled={isSubmitting}
            data-testid="input-new-title"
          />
          <button type="submit" disabled={isSubmitting || !newTitle.trim()} data-testid="btn-update-title">
            Rename (Direct Host Command)
          </button>
        </form>
      </div>

      <div className="items-list" data-testid="items-list">
        <h3>Agenda Items ({meeting.items.length})</h3>
        {meeting.items.map(item => {
          const isSelected = selectedItemId === item.id;
          return (
            <div
              key={item.id}
              className={`agenda-item-card ${isSelected ? 'selected' : ''}`}
              data-testid={`agenda-item-${item.id}`}
              onClick={() => onSelectItem?.(isSelected ? null : item.id)}
              style={{
                border: isSelected ? '2px solid #2563eb' : '1px solid #e5e7eb',
                padding: '0.75rem',
                margin: '0.5rem 0',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>{item.title}</strong>
                  <span style={{ fontSize: '0.75rem', color: '#6b7280', marginLeft: '0.5rem' }}>
                    (v{item.version})
                  </span>
                  <div style={{ fontSize: '0.85rem', color: '#4b5563' }}>
                    Duration: {item.durationMinutes}m | Presenter: {item.presenter}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    data-testid={`btn-pin-${item.id}`}
                    onClick={e => {
                      e.stopPropagation();
                      void handleCommand({ type: 'set_item_pin', itemId: item.id, pinned: !item.pinned });
                    }}
                  >
                    {item.pinned ? 'Pinned' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    data-testid={`btn-add-10m-${item.id}`}
                    onClick={e => {
                      e.stopPropagation();
                      void handleCommand({
                        type: 'edit_item',
                        itemId: item.id,
                        durationMinutes: item.durationMinutes + 10,
                      });
                    }}
                  >
                    +10m
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function HostAgendaApp({
  meeting: initialMeeting,
  workspaceId,
  serverUrl,
  ownerId = 'agenda-user-default',
  transport,
}: {
  meeting: HostAgendaMeeting;
  workspaceId: string;
  serverUrl: string;
  ownerId?: string;
  transport?: any;
}) {
  const [meeting, setMeeting] = useState<HostAgendaMeeting>(initialMeeting);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const refreshMeeting = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/host/meetings/${meeting.id}`, {
        headers: { 'X-Owner-ID': ownerId },
      });
      if (res.ok) {
        const data = await res.json();
        setMeeting(data);
      }
    } catch {
      // Ignore network errors on refresh
    }
  };

  const executeCommand = async (command: HostAgendaCommand, expectedVersion: number) => {
    try {
      const res = await fetch(`${serverUrl}/api/host/meetings/${meeting.id}/commands`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Owner-ID': ownerId,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          expectedVersion,
          command,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        return { ok: false, error: errJson.error || `HTTP ${res.status}` };
      }

      await refreshMeeting();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  };

  return (
    <InteractionProvider workspaceId={workspaceId} transport={transport}>
      <div className="host-agenda-app-container" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
        <AgendaChat selectedItemId={selectedItemId} />
        <HostAgendaViewer
          meeting={meeting}
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
          onExecuteCommand={executeCommand}
          onRefreshMeeting={refreshMeeting}
        />
      </div>
    </InteractionProvider>
  );
}
