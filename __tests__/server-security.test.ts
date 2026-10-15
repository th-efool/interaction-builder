import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import { createAgendaServer, type ServerOptions } from '../examples/agenda/server';

describe('Standalone Server Security & Trusted Boundary', () => {
  let serverInstance: Awaited<ReturnType<typeof createAgendaServer>> | null = null;
  const testPort = 3987;
  const baseUrl = `http://127.0.0.1:${testPort}`;

  afterEach(async () => {
    if (serverInstance) {
      await serverInstance.close();
      serverInstance = null;
    }
  });

  it('1. Rejects insecure demo authentication when NODE_ENV=production', async () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        createAgendaServer({
          port: testPort,
          databaseUrl: 'memory',
          allowInsecureDemoAuth: true,
        })
      ).rejects.toThrow('SECURITY_ERROR: Insecure demo authentication is strictly forbidden in production mode');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  it('2. Enforces 401 Unauthorized when demo auth is disabled and no principal resolved', async () => {
    serverInstance = await createAgendaServer({
      port: testPort,
      databaseUrl: 'memory',
      allowInsecureDemoAuth: false,
    });
    await serverInstance.start();

    const res = await fetch(`${baseUrl}/api/host/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingTitle: 'Secret Sync' }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('3. Accepts authenticated requests through custom PrincipalResolver', async () => {
    serverInstance = await createAgendaServer({
      port: testPort,
      databaseUrl: 'memory',
      allowInsecureDemoAuth: false,
      principalResolver: async (req) => {
        const auth = req.headers.authorization;
        if (auth === 'Bearer token-vp-marketing') {
          return { ownerId: 'user-vp-marketing', role: 'executive' };
        }
        return null;
      },
    });
    await serverInstance.start();

    // Valid auth
    const createRes = await fetch(`${baseUrl}/api/host/meetings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token-vp-marketing',
      },
      body: JSON.stringify({ meetingTitle: 'Marketing Vision 2027' }),
    });
    expect(createRes.status).toBe(201);
    const meeting = await createRes.json();
    expect(meeting.ownerId).toBe('user-vp-marketing');
    expect(meeting.meetingTitle).toBe('Marketing Vision 2027');

    // Invalid auth
    const unauthRes = await fetch(`${baseUrl}/api/host/meetings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ meetingTitle: 'Bad Sync' }),
    });
    expect(unauthRes.status).toBe(401);
  });

  it('4. Rejects client attempt to override resource ownerId (anti-impersonation)', async () => {
    serverInstance = await createAgendaServer({
      port: testPort,
      databaseUrl: 'memory',
      principalResolver: async () => ({ ownerId: 'trusted-user-1' }),
    });
    await serverInstance.start();

    const forgedRes = await fetch(`${baseUrl}/api/host/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerId: 'victim-ceo-user', // Attempted forge
        meetingTitle: 'Hostile Takeover Meeting',
      }),
    });

    expect(forgedRes.status).toBe(400);
    const err = await forgedRes.json();
    expect(err.code).toBe('FORBIDDEN_OWNERSHIP_OVERRIDE');
  });

  it('5. Enforces cross-user isolation for host resource reads and commands', async () => {
    serverInstance = await createAgendaServer({
      port: testPort,
      databaseUrl: 'memory',
      principalResolver: async (req) => {
        const token = req.headers.authorization;
        if (token === 'Bearer user-a') return { ownerId: 'user-a' };
        if (token === 'Bearer user-b') return { ownerId: 'user-b' };
        return null;
      },
    });
    await serverInstance.start();

    // User A creates meeting
    const resA = await fetch(`${baseUrl}/api/host/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-a' },
      body: JSON.stringify({ meetingTitle: 'User A Confidential' }),
    });
    const meetingA = await resA.json();

    // User B attempts to read User A's meeting
    const readB = await fetch(`${baseUrl}/api/host/meetings/${meetingA.id}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer user-b' },
    });
    expect(readB.status).toBe(404);

    // User B attempts to command User A's meeting
    const cmdB = await fetch(`${baseUrl}/api/host/meetings/${meetingA.id}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-b' },
      body: JSON.stringify({
        commandId: 'c1000000-0000-4000-8000-000000000001',
        expectedVersion: 0,
        command: { type: 'set_meeting_title', title: 'Tampered Title' },
      }),
    });
    expect(cmdB.status).toBe(403);
    const cmdErr = await cmdB.json();
    expect(cmdErr.code).toBe('FORBIDDEN');
  });

  it('6. Rejects disallowed CORS origins before processing side-effects', async () => {
    serverInstance = await createAgendaServer({
      port: testPort,
      databaseUrl: 'memory',
      allowedOrigins: ['http://trusted-client.internal:3000'],
      allowInsecureDemoAuth: true,
    });
    await serverInstance.start();

    // Allowed origin
    const allowedRes = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://trusted-client.internal:3000' },
    });
    expect(allowedRes.status).toBe(200);
    expect(allowedRes.headers.get('access-control-allow-origin')).toBe('http://trusted-client.internal:3000');

    // Malicious/Disallowed origin
    const forbiddenRes = await fetch(`${baseUrl}/api/host/meetings`, {
      method: 'POST',
      headers: {
        Origin: 'http://malicious-site.attacker.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ meetingTitle: 'Exploit' }),
    });
    expect(forbiddenRes.status).toBe(403);
    const body = await forbiddenRes.json();
    expect(body.code).toBe('CORS_FORBIDDEN');
  });

  it('7. Enforces streaming body byte limit and returns 413 Payload Too Large', async () => {
    serverInstance = await createAgendaServer({
      port: testPort,
      databaseUrl: 'memory',
      maxBodyBytes: 1024, // 1KB limit for test
      allowInsecureDemoAuth: true,
    });
    await serverInstance.start();

    const oversizedString = 'x'.repeat(4096);
    const res = await fetch(`${baseUrl}/api/host/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingTitle: oversizedString }),
    });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('8. Validates Content-Type on mutating requests (415 Unsupported Media Type)', async () => {
    serverInstance = await createAgendaServer({
      port: testPort,
      databaseUrl: 'memory',
      allowInsecureDemoAuth: true,
    });
    await serverInstance.start();

    const res = await fetch(`${baseUrl}/api/host/meetings`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'Invalid raw plain text body',
    });

    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('9. Binds to loopback interface 127.0.0.1 by default', async () => {
    serverInstance = await createAgendaServer({
      port: testPort,
      databaseUrl: 'memory',
      allowInsecureDemoAuth: true,
    });
    const url = await serverInstance.start();

    expect(url).toContain('127.0.0.1');
    expect(serverInstance.host).toBe('127.0.0.1');
  });
});
