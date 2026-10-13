import type { Pool } from 'pg';
import { type InteractionRepository } from '../../runtime/repository';
export interface PgAdapterOptions {
    pool?: Pool;
    connectionString?: string;
}
export interface PgInteractionRepository extends InteractionRepository {
    checkHealth(): Promise<{
        ok: boolean;
        latencyMs: number;
        poolStatus: {
            totalCount: number;
            idleCount: number;
            waitingCount: number;
        };
    }>;
}
export declare function createPgInteractionRepository(options: PgAdapterOptions): PgInteractionRepository;
//# sourceMappingURL=index.d.ts.map