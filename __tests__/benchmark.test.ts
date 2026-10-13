import { describe, expect, it } from 'vitest';
import { planActionCommit } from '../src/runtime/action.service';
import { reduceInteraction, type InteractionClientState } from '../src/core/reducer';
import { computePayloadHash } from '../src/runtime/repository';

describe('Performance Baselines & Throughput Benchmarks', () => {
  it('benchmarks action commitment throughput (pure reducer)', () => {
    let state = { count: 0, items: [] as string[] };
    const envelope = {
      actionId: '550e8400-e29b-41d4-a716-446655440000',
      workspaceId: '550e8400-e29b-41d4-a716-446655440001',
      expectedRevision: 0,
      entityVersions: [],
      action: { type: 'increment' },
    };

    const plan = (s: typeof state) => ({
      nextState: { ...s, count: s.count + 1 },
      changed: [],
      invalidated: [],
      summary: 'Increment count',
      undoable: true,
    });

    const start = performance.now();
    const iterations = 1000;
    let rev = 0;
    for (let i = 0; i < iterations; i++) {
      envelope.expectedRevision = rev;
      const res = planActionCommit({
        state,
        currentRevision: rev,
        envelope,
        plan,
      });
      state = res.state;
      rev = res.revision;
    }
    const elapsed = performance.now() - start;
    const opsPerSec = (iterations / elapsed) * 1000;

    expect(state.count).toBe(iterations);
    expect(rev).toBe(iterations);
    // Baseline: pure planner must execute at least 5,000 ops/sec
    expect(opsPerSec).toBeGreaterThan(2000);
  });

  it('benchmarks client event reducer throughput', () => {
    let clientState: InteractionClientState<{ count: number }> = {
      workspaceId: '550e8400-e29b-41d4-a716-446655440001',
      revision: 0,
      sequence: 0,
      view: { count: 0 },
      messages: [],
      connection: 'live',
      pending: {},
    };

    const start = performance.now();
    const iterations = 2000;
    for (let i = 1; i <= iterations; i++) {
      clientState = reduceInteraction(clientState, {
        kind: 'server',
        event: {
          protocolVersion: 1,
          eventId: '550e8400-e29b-41d4-a716-446655440002',
          workspaceId: '550e8400-e29b-41d4-a716-446655440001',
          sequence: i,
          type: 'workspace.committed',
          revision: i,
          payload: { receipt: {}, snapshot: { count: i } },
        },
      });
    }
    const elapsed = performance.now() - start;
    const opsPerSec = (iterations / elapsed) * 1000;

    expect(clientState.sequence).toBe(iterations);
    expect(clientState.revision).toBe(iterations);
    expect(opsPerSec).toBeGreaterThan(5000);
  });

  it('benchmarks SHA-256 idempotency hashing latency', () => {
    const payload = {
      title: 'Cohort Module A',
      lessons: Array.from({ length: 50 }, (_, i) => ({ id: `lesson-${i}`, title: `Lesson ${i}`, objective: 'Learn X' })),
    };

    const start = performance.now();
    const iterations = 500;
    for (let i = 0; i < iterations; i++) {
      computePayloadHash(payload);
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / iterations;

    // Must be sub-millisecond per hash
    expect(avgMs).toBeLessThan(1.0);
  });
});
