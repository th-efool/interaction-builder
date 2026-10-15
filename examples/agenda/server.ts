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
import { hostBoundAgendaDomain, type HostAgendaMeeting } from './host-agenda.domain';
import {
  createPgHostAgendaRepository,
  createMemoryHostAgendaRepository,
  type HostAgendaRepository,
} from './host-agenda.repository';
import { HostAgendaService } from './host-agenda.service';
import { startHostAgendaWorker } from './host-agenda.worker';

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
  let hostRepo: HostAgendaRepository;
  let pool: pg.Pool | undefined;
  const isPg = Boolean(databaseUrl && databaseUrl !== 'memory');

  if (isPg) {
    const pgPool = new PgPool({ connectionString: databaseUrl });
    pgPool.on('error', () => {
      // Ignore background connection resets on shutdown
    });
    pool = pgPool;

    // Apply standard schema migration for interaction engine
    const migrationDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../migrations/001_interaction_schema.sql'
    );
    if (fs.existsSync(migrationDir)) {
      const sql = fs.readFileSync(migrationDir, 'utf8');
      await pgPool.query(sql);
    }

    // Apply host-owned business schema migration
    const hostMigrationPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'host-schema.sql'
    );
    if (fs.existsSync(hostMigrationPath)) {
      const hostSql = fs.readFileSync(hostMigrationPath, 'utf8');
      await pgPool.query(hostSql);
    }

    repo = createPgInteractionRepository({ pool: pgPool });
    hostRepo = createPgHostAgendaRepository({ pool: pgPool });
  } else {
    repo = createMemoryInteractionRepository();
    hostRepo = createMemoryHostAgendaRepository();
  }

  const hostService = new HostAgendaService(hostRepo);

  const domains = new Map<string, any>([
    [agendaDomain.id, agendaDomain],
    [hostBoundAgendaDomain.id, hostBoundAgendaDomain],
  ]);

  const handlers = createInteractionHandlers({
    repo,
    domains,
  });

  let workerHandle: { stop: () => Promise<void> } | null = null;
  if (options.enableEmbeddedWorker ?? process.env.EMBEDDED_WORKER === 'true') {
    workerHandle = startAgendaWorker({ repo, pool, hostService, pollIntervalMs: 250 });
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

    // Read incoming body buffer
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const bodyBuffer = Buffer.concat(chunks);
    const ownerId = (req.headers['x-owner-id'] as string) || 'agenda-user-default';

    // -------------------------------------------------------------
    // Host-Owned Business Resource Endpoints
    // -------------------------------------------------------------
    if (url.pathname.startsWith('/api/host/meetings')) {
      const subpath = url.pathname.slice('/api/host/meetings'.length);
      const segments = subpath.split('/').filter(Boolean);

      try {
        // POST /api/host/meetings (Create meeting)
        if (segments.length === 0 && req.method === 'POST') {
          const body = JSON.parse(bodyBuffer.toString('utf8') || '{}');
          const meeting: HostAgendaMeeting = {
            id: body.id || crypto.randomUUID(),
            ownerId: body.ownerId || ownerId,
            version: 0,
            meetingTitle: body.meetingTitle || 'New Meeting',
            date: body.date || new Date().toISOString().split('T')[0],
            items: (body.items || []).map((it: any, idx: number) => ({
              id: it.id || `item-${idx + 1}`,
              version: 0,
              title: it.title || 'Topic',
              durationMinutes: it.durationMinutes || 15,
              presenter: it.presenter || 'Team',
              pinned: Boolean(it.pinned),
              sortOrder: idx,
            })),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          const created = await hostService.createMeeting(meeting);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(created));
          return;
        }

        // GET /api/host/meetings/:id (Authoritative read)
        if (segments.length === 1 && req.method === 'GET') {
          const meetingId = segments[0];
          const meeting = await hostService.getMeeting(ownerId, meetingId);
          if (!meeting) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'NOT_FOUND', error: 'Meeting not found.' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(meeting));
          return;
        }

        // POST /api/host/meetings/:id/commands (Authorized typed command execution)
        if (segments.length === 2 && segments[1] === 'commands' && req.method === 'POST') {
          const meetingId = segments[0];
          const body = JSON.parse(bodyBuffer.toString('utf8') || '{}');
          const commandId =
            (req.headers['idempotency-key'] as string) ||
            body.commandId ||
            crypto.randomUUID();

          const receipt = await hostService.executeCommand({
            commandId,
            ownerId,
            resourceId: meetingId,
            expectedVersion: body.expectedVersion,
            readSet: body.readSet,
            command: body.command,
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ receipt }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'NOT_FOUND', error: 'Endpoint not found.' }));
        return;
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('STALE_HOST_RESOURCE') || msg.includes('STALE_ENTITY') || msg.includes('CONFLICT')) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'CONFLICT', error: msg }));
          return;
        }
        if (msg.includes('UNAUTHORIZED_OWNER') || msg.includes('Access denied')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'FORBIDDEN', error: msg }));
          return;
        }
        if (msg.includes('UNKNOWN_AGENDA_MEETING') || msg.includes('not found')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'NOT_FOUND', error: msg }));
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'INTERNAL_ERROR', error: msg }));
        return;
      }
    }

    // -------------------------------------------------------------
    // Interaction Builder Orchestration Endpoints
    // -------------------------------------------------------------
    if (url.pathname.startsWith('/api/interaction/v1/')) {
      const segments = url.pathname.slice('/api/interaction/v1/'.length).split('/').filter(Boolean);

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
          async () => ownerId,
          handlers
        );

        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

        if (response.body) {
          Readable.fromWeb(response.body as any).pipe(res);
        } else {
          res.end();
        }
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || 'Internal error' }));
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  return {
    server,
    port,
    repo,
    hostRepo,
    hostService,
    async start(): Promise<string> {
      return new Promise((resolve) => {
        server.listen(port, () => {
          console.log(`[Agenda Server] Listening on http://localhost:${port} (${isPg ? 'PostgreSQL' : 'memory'})`);
          resolve(`http://localhost:${port}`);
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
