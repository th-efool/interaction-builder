import { describe, expect, it } from 'vitest';
import { planActionCommit } from '../src/runtime/action.service';
import { agendaDomain, sampleAgenda, type AgendaWorkspace } from '../src/testkit/agenda-domain';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const actionId = '00000000-0000-4000-8000-000000000002';

describe('interaction action commit boundary', () => {
  it('returns new revision and receipt from typed domain plan', () => {
    const result = planActionCommit({
      state: sampleAgenda,
      currentRevision: 0,
      envelope: {
        actionId,
        workspaceId,
        expectedRevision: 0,
        entityVersions: [],
        action: { type: 'set_meeting_title', title: 'Q1 Review' },
      },
      plan: agendaDomain.plan,
    });
    expect(result.revision).toBe(1);
    expect(result.state.meetingTitle).toBe('Q1 Review');
    expect(result.receipt).toMatchObject({ actionId, revision: 1, undoable: true });
  });

  it('rejects stale workspace before domain planning', () => {
    expect(() =>
      planActionCommit({
        state: sampleAgenda,
        currentRevision: 2,
        envelope: {
          actionId,
          workspaceId,
          expectedRevision: 1,
          entityVersions: [],
          action: { type: 'set_meeting_title', title: 'Never' },
        },
        plan: agendaDomain.plan,
      })
    ).toThrow('STALE_WORKSPACE');
  });
});
