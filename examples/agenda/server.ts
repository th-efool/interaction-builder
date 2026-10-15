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

export interface Principal {
  ownerId: string;
  role?: string;
}

export type PrincipalResolver = (req: http.IncomingMessage) => Promise<Principal | null>;

export interface ServerOptions {
  host?: string;
  port?: number;
  databaseUrl?: string;
  enableEmbeddedWorker?: boolean;
  principalResolver?: PrincipalResolver;
  allowInsecureDemoAuth?: boolean;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  autoMigrate?: boolean;
  staticDir?: string;
}

export async function createAgendaServer(options: ServerOptions = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT || 3030);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;

  const isProduction = process.env.NODE_ENV === 'production';
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

  // Determine if insecure demo auth (X-Owner-ID or default fallback) is permitted
  const allowInsecureDemoAuth =
    options.allowInsecureDemoAuth ??
    (process.env.ALLOW_INSECURE_DEMO_AUTH === 'true' || (!isProduction && isLoopback));

  if (isProduction && options.allowInsecureDemoAuth) {
    throw new Error('SECURITY_ERROR: Insecure demo authentication is strictly forbidden in production mode (NODE_ENV=production).');
  }

  if (!isLoopback && allowInsecureDemoAuth && options.allowInsecureDemoAuth === undefined) {
    throw new Error(
      `SECURITY_ERROR: Insecure demo authentication cannot bind to non-loopback host (${host}) without explicit ServerOptions.allowInsecureDemoAuth opt-in.`
    );
  }

  let repo;
  let hostRepo: HostAgendaRepository;
  let pool: pg.Pool | undefined;
  const isPg = Boolean(databaseUrl && databaseUrl !== 'memory');

  const shouldAutoMigrate = options.autoMigrate ?? (process.env.AUTO_MIGRATE === 'true' || !isProduction);

  if (isPg) {
    const pgPool = new PgPool({ connectionString: databaseUrl });
    pgPool.on('error', () => {
      // Ignore background connection resets on shutdown
    });
    pool = pgPool;

    if (shouldAutoMigrate) {
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

  const allowedOrigins =
    options.allowedOrigins ??
    (process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
      : [
          'http://localhost:3000',
          'http://127.0.0.1:3000',
          'http://localhost:3030',
          'http://127.0.0.1:3030',
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          `http://${host}:${port}`,
          `http://localhost:${port}`,
          `http://127.0.0.1:${port}`,
        ]);

  const maxBodyBytes =
    options.maxBodyBytes ?? (process.env.MAX_BODY_BYTES ? Number(process.env.MAX_BODY_BYTES) : 1024 * 1024); // 1MB default

  const server = http.createServer(async (req, res) => {
    // -------------------------------------------------------------
    // 1. CORS Validation & Allowed Origin Pre-flight
    // -------------------------------------------------------------
    const origin = req.headers.origin;
    if (origin) {
      const isAllowed = allowedOrigins.includes(origin) || allowedOrigins.includes('*');
      if (!isAllowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'CORS_FORBIDDEN', error: `Origin "${origin}" is not allowed.` }));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Idempotency-Key, Last-Event-ID, X-Owner-ID'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const hostHeader = req.headers.host || `${host}:${port}`;
    const url = new URL(req.url || '/', `http://${hostHeader}`);

    // Health check endpoint (safe, bounded, zero data exposure)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', storage: isPg ? 'postgres' : 'memory', loopback: isLoopback }));
      return;
    }

    // -------------------------------------------------------------
    // 2. Streaming Request Body & Byte Limit Enforcement
    // -------------------------------------------------------------
    let bytesRead = 0;
    let payloadExceeded = false;
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytesRead += buf.length;
      if (bytesRead > maxBodyBytes) {
        payloadExceeded = true;
        break;
      }
      chunks.push(buf);
    }

    if (payloadExceeded) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 'PAYLOAD_TOO_LARGE',
          error: `Request body exceeds maximum size limit of ${maxBodyBytes} bytes.`,
        })
      );
      return;
    }

    const bodyBuffer = Buffer.concat(chunks);

    // -------------------------------------------------------------
    // 3. Content-Type and Method Validation
    // -------------------------------------------------------------
    if (['POST', 'PUT', 'PATCH'].includes(req.method || '')) {
      const contentType = req.headers['content-type'] || '';
      if (bodyBuffer.length > 0 && !contentType.toLowerCase().includes('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'UNSUPPORTED_MEDIA_TYPE', error: 'Content-Type must be application/json.' }));
        return;
      }
    }

    // -------------------------------------------------------------
    // 4. Trusted Principal Resolution
    // -------------------------------------------------------------
    let principal: Principal | null = null;
    if (options.principalResolver) {
      principal = await options.principalResolver(req);
    } else if (allowInsecureDemoAuth) {
      // Insecure demo mode: accept header or use default demo user
      const headerOwner = req.headers['x-owner-id'];
      if (typeof headerOwner === 'string' && headerOwner.trim().length > 0) {
        principal = { ownerId: headerOwner.trim() };
      } else {
        principal = { ownerId: 'agenda-user-default' };
      }
    }

    if (!principal) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 'UNAUTHORIZED',
          error: 'Authentication required. No valid principal could be resolved.',
        })
      );
      return;
    }

    const trustedOwnerId = principal.ownerId;

    // -------------------------------------------------------------
    // 5. Host-Owned Business Resource Endpoints
    // -------------------------------------------------------------
    if (url.pathname.startsWith('/api/host/meetings')) {
      const subpath = url.pathname.slice('/api/host/meetings'.length);
      const segments = subpath.split('/').filter(Boolean);

      try {
        // POST /api/host/meetings (Create meeting)
        if (segments.length === 0 && req.method === 'POST') {
          let body: any = {};
          try {
            body = JSON.parse(bodyBuffer.toString('utf8') || '{}');
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'INVALID_JSON', error: 'Malformed JSON payload.' }));
            return;
          }

          // Anti-impersonation: forbid client override of ownerId
          if (body.ownerId && body.ownerId !== trustedOwnerId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                code: 'FORBIDDEN_OWNERSHIP_OVERRIDE',
                error: 'Cannot create meeting for an owner other than the authenticated principal.',
              })
            );
            return;
          }

          const meeting: HostAgendaMeeting = {
            id: body.id || crypto.randomUUID(),
            ownerId: trustedOwnerId, // Bound strictly to authenticated principal
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
          const meeting = await hostService.getMeeting(trustedOwnerId, meetingId);
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
          let body: any = {};
          try {
            body = JSON.parse(bodyBuffer.toString('utf8') || '{}');
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'INVALID_JSON', error: 'Malformed JSON payload.' }));
            return;
          }

          // Anti-impersonation: forbid client override of ownerId
          if (body.ownerId && body.ownerId !== trustedOwnerId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                code: 'FORBIDDEN_OWNERSHIP_OVERRIDE',
                error: 'Command ownerId does not match the authenticated principal.',
              })
            );
            return;
          }

          const commandId =
            (req.headers['idempotency-key'] as string) ||
            body.commandId ||
            crypto.randomUUID();

          const receipt = await hostService.executeCommand({
            commandId,
            ownerId: trustedOwnerId, // Bound strictly to authenticated principal
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
        res.end(JSON.stringify({ code: 'INTERNAL_ERROR', error: 'Internal operation failed.' }));
        return;
      }
    }

    // -------------------------------------------------------------
    // 6. Interaction Builder Orchestration Endpoints
    // -------------------------------------------------------------
    if (url.pathname.startsWith('/api/interaction/v1/')) {
      const segments = url.pathname.slice('/api/interaction/v1/'.length).split('/').filter(Boolean);

      const webHeaders = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          if (Array.isArray(value)) {
            value.forEach((v) => webHeaders.append(key, v));
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
          async () => trustedOwnerId, // Bound strictly to authenticated principal
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
          res.end(JSON.stringify({ error: 'Internal interaction error' }));
        }
      }
      return;
    }

    // -------------------------------------------------------------
    // 7. Static Asset & Client Page Serving
    // -------------------------------------------------------------
    if (req.method === 'GET' && options.staticDir) {
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/profile1' || url.pathname === '/profile2') {
        const indexPath = path.join(options.staticDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          const html = fs.readFileSync(indexPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
      }
      if (url.pathname.startsWith('/assets/')) {
        const assetFile = path.basename(url.pathname);
        const assetPath = path.join(options.staticDir, assetFile);
        if (fs.existsSync(assetPath)) {
          const ext = path.extname(assetFile).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.js': 'application/javascript; charset=utf-8',
            '.mjs': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.html': 'text/html; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
          };
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
          fs.createReadStream(assetPath).pipe(res);
          return;
        }
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  return {
    server,
    host,
    port,
    repo,
    hostRepo,
    hostService,
    async start(): Promise<string> {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, host, () => {
          console.log(`[Agenda Server] Listening on http://${host}:${port} (${isPg ? 'PostgreSQL' : 'memory'})`);
          resolve(`http://${host}:${port}`);
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
  void runStandaloneServer().catch((err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
}
