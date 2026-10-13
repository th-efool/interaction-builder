import { describe, expect, it } from 'vitest';
import { createPgInteractionRepository } from '../src/adapters/pg';

describe('PostgreSQL Adapter Construction & ESM Compatibility', () => {
  it('instantiates repository from connectionString without throwing dynamic require error', () => {
    const repo = createPgInteractionRepository({
      connectionString: 'postgresql://user:pass@localhost:5432/unused_db',
    });

    expect(repo).toBeDefined();
    expect(typeof repo.createWorkspace).toBe('function');
    expect(typeof repo.commitAction).toBe('function');
    expect(typeof repo.scheduleRun).toBe('function');
    expect(typeof repo.claimRun).toBe('function');
    expect(typeof repo.recordStep).toBe('function');
  });

  it('instantiates repository from injected pool instance', () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
    } as any;

    const repo = createPgInteractionRepository({
      pool: mockPool,
    });

    expect(repo).toBeDefined();
    expect(typeof repo.createWorkspace).toBe('function');
    expect(typeof repo.commitAction).toBe('function');
  });

  it('throws helpful error if neither pool nor connectionString is provided', () => {
    expect(() => {
      createPgInteractionRepository({} as any);
    }).toThrow('Either pool or connectionString must be provided');
  });
});
