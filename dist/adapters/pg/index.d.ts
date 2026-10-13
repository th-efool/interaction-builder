import type { Pool } from 'pg';
import { type InteractionRepository } from '../../runtime/repository';
export interface PgAdapterOptions {
    pool?: Pool;
    connectionString?: string;
}
export declare function createPgInteractionRepository(options: PgAdapterOptions): InteractionRepository;
//# sourceMappingURL=index.d.ts.map