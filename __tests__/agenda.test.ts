import { describe, expect, it } from 'vitest';
import { runAgendaExample } from '../examples/agenda/run';

describe('Standalone Agenda Domain (Portability & Independence)', () => {
  it('executes the complete agenda workflow without any cohort or host dependencies', async () => {
    const finalWs = await runAgendaExample();
    expect(finalWs).toBeDefined();
    expect(finalWs?.revision).toBe(3); // 1 for title, 1 for duration, 1 for pin
    expect(finalWs?.snapshot.meetingTitle).toBe('Q4 Strategy & Architecture');
    expect(finalWs?.snapshot.items[0]?.durationMinutes).toBe(40);
    expect(finalWs?.snapshot.items[0]?.pinned).toBe(true);
  });
});
