import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import pg from 'pg';
import { createInteractionHandlers, createMemoryInteractionRepository } from 'interaction-builder/runtime';
import { dispatchInteraction } from 'interaction-builder/adapters/http';
import { createPgInteractionRepository } from 'interaction-builder/adapters/pg';
import { agendaDomain } from './agenda.domain';
import { startAgendaWorker } from './worker';

const PgPool = (pg as any)?.Pool ?? (pg as any)?.default?.Pool ?? pg.Pool;

export interface ServerOptions {
  port?: number;
  databaseUrl?: string;
  enableEmbeddedWorker?: boolean;
}

export async function createAgendaServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT || 3030);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;

  let repo;
  let pool: pg.Pool | undefined;
  const isPg = Boolean(databaseUrl && databaseUrl !== 'memory');

  if (isPg) {
    const pgPool = new PgPool({ connectionString: databaseUrl });
    pgPool.on('error', () => {
      // Ignore background connection resets on shutdown
    });
    pool = pgPool;
    // Apply standard schema migration if tables don't exist
    const migrationPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../migrations/001_interaction_schema.sql'
    );
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf8');
      await pgPool.query(sql);
    }
    repo = createPgInteractionRepository({ pool: pgPool });
  } else {
    repo = createMemoryInteractionRepository();
  }

  const domains = new Map([[agendaDomain.id, agendaDomain]]);
  const handlers = createInteractionHandlers({
    repo,
    domains,
  });

  let workerHandle: { stop: () => Promise<void> } | null = null;
  if (options.enableEmbeddedWorker ?? process.env.EMBEDDED_WORKER === 'true') {
    workerHandle = startAgendaWorker({ repo, pool, pollIntervalMs: 250 });
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, Last-Event-ID, X-Owner-ID');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || `localhost:${port}`;
    const url = new URL(req.url || '/', `http://${host}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', storage: isPg ? 'postgres' : 'memory' }));
      return;
    }

    if (url.pathname.startsWith('/api/interaction/v1/')) {
      const segments = url.pathname.slice('/api/interaction/v1/'.length).split('/').filter(Boolean);
      const ownerId = (req.headers['x-owner-id'] as string) || 'agenda-user-default';

      // Read incoming body buffer
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const bodyBuffer = Buffer.concat(chunks);

      const webHeaders = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          if (Array.isArray(value)) {
            value.forEach(v => webHeaders.append(key, v));
          } else {
            webHeaders.set(key, value);
          }
        }
      }

      const webRequest = new Request(url.toString(), {
        method: req.method,
        headers: webHeaders,
        body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') ? undefined : bodyBuffer,
      });

      try {
        const response = await dispatchInteraction(
          webRequest,
          segments,
          () => Promise.resolve(ownerId),
          handlers
        );

        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

        if (response.body) {
          Readable.fromWeb(response.body as any).pipe(res);
        } else {
          res.end();
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ code: 'SERVER_ERROR', message: String(err) }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Route not found' }));
  });

  return {
    server,
    repo,
    pool,
    port,
    async start() {
      return new Promise<void>((resolve) => {
        server.listen(port, () => {
          console.log(`[Agenda Server] Listening on http://localhost:${port} (${isPg ? 'PostgreSQL' : 'In-Memory'})`);
          resolve();
        });
      });
    },
    async close() {
      if (workerHandle) {
        await workerHandle.stop();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (pool) {
        await pool.end();
      }
    },
  };
}

export async function runStandaloneServer() {
  const server = await createAgendaServer();
  await server.start();

  const shutdown = async () => {
    console.log('[Agenda Server] Shutting down...');
    await server.close();
    console.log('[Agenda Server] Clean shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  void runStandaloneServer().catch(err => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
}
