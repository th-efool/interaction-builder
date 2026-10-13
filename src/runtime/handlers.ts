import { z } from 'zod';
import { actionEnvelopeSchema, type DomainActionPlan } from '../core/contracts';
import type { InteractionRepository } from './repository';

/** Host-registered domain. Engine knows nothing about cohorts/agendas. */
export interface DomainDefinition<State = any> {
  id: string;
  version: number;
  /** Validate + build initial state from client bootstrap. */
  initialState(bootstrap: unknown): State;
  plan(
    state: State,
    action: unknown,
    ctx: {
      actionId: string;
      workspaceId: string;
      expectedRevision: number;
      currentRevision: number;
      entityVersions: ReadonlyMap<string, number>;
    }
  ): DomainActionPlan<State>;
}

export interface InteractionHandlerDeps {
  repo: InteractionRepository;
  domains: ReadonlyMap<string, DomainDefinition>;
  onUserMessageAppended?: (ctx: { ownerId: string; workspaceId: string }) => void | Promise<void>;
  runAssistant?: (ownerId: string, workspaceId: string) => Promise<HandlerResult>;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

const createSchema = z.strictObject({
  workspaceId: z.string().uuid(),
  domainId: z.string().min(1).max(80),
  bootstrap: z.unknown(),
});

/** Users may only send text and entity references (selection chips); other part types are server-authored. */
const sendMessageSchema = z.strictObject({
  id: z.string().uuid(),
  parts: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('text'), text: z.string().trim().min(1).max(8_000) }),
        z.strictObject({
          type: z.literal('entity_ref'),
          entity: z.strictObject({
            kind: z.string().min(1).max(80),
            id: z.string().min(1).max(200),
            version: z.number().int().nonnegative(),
          }),
          label: z.string().max(300),
        }),
      ])
    )
    .min(1)
    .max(20),
});

const cancelRunSchema = z.strictObject({
  reason: z.string().max(500).optional(),
});

const decideProposalSchema = z.strictObject({
  decision: z.enum(['accepted', 'rejected']),
});

const ERROR_STATUS: Record<string, number> = {
  STALE_WORKSPACE: 409,
  STALE_ENTITY: 409,
  IDEMPOTENCY_MISMATCH: 409,
  WORKSPACE_NOT_FOUND: 404,
  WORKSPACE_OWNER_MISMATCH: 404,
  WORKSPACE_NOT_ACTIVE: 409,
  RUN_NOT_FOUND: 404,
  RUN_CANCELED: 409,
  FENCE_EXPIRED: 409,
  PROPOSAL_NOT_FOUND: 404,
  STALE_PROPOSAL: 409,
  PROPOSAL_EXPIRED: 410,
};

/** Maps thrown errors to the public envelope; never leaks raw messages. */
export function toErrorResult(err: unknown, correlationId = crypto.randomUUID()): HandlerResult {
  const code = err instanceof Error ? err.message : 'INTERNAL';
  if (err instanceof z.ZodError) {
    return {
      status: 400,
      body: { code: 'INVALID_ACTION', message: 'Invalid request', retryable: false, correlationId },
    };
  }
  const status = ERROR_STATUS[code];
  if (status) {
    return {
      status,
      body: {
        code:
          status === 404
            ? 'NOT_FOUND'
            : code === 'STALE_WORKSPACE' || code === 'STALE_ENTITY'
            ? 'CONFLICT'
            : code,
        message: code,
        retryable: false,
        correlationId,
      },
    };
  }
  if (/^[A-Z_]+$/.test(code)) {
    return {
      status: 422,
      body: { code: 'INVALID_ACTION', message: code, retryable: false, correlationId },
    };
  }
  return {
    status: 500,
    body: { code: 'INTERNAL', message: 'Internal error', retryable: true, correlationId },
  };
}

export function createInteractionHandlers(deps: InteractionHandlerDeps) {
  return {
    async createWorkspace(ownerId: string, input: unknown): Promise<HandlerResult> {
      try {
        const body = createSchema.parse(input);
        const domain = deps.domains.get(body.domainId);
        if (!domain) {
          return {
            status: 400,
            body: { code: 'INVALID_ACTION', message: 'Unknown domain', retryable: false },
          };
        }
        const ws = await deps.repo.createWorkspace({
          id: body.workspaceId,
          ownerId,
          domainId: domain.id,
          domainVersion: domain.version,
          initialSnapshot: domain.initialState(body.bootstrap),
        });
        return {
          status: 201,
          body: {
            workspaceId: ws.id,
            revision: ws.revision,
            cursor: ws.sequence,
            snapshot: ws.snapshot,
          },
        };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async getWorkspace(ownerId: string, workspaceId: string): Promise<HandlerResult> {
      try {
        const ws = await deps.repo.loadWorkspace({ workspaceId, ownerId });
        if (!ws) return toErrorResult(new Error('WORKSPACE_NOT_FOUND'));
        const messages = await deps.repo.listMessages({ workspaceId, ownerId, limit: 50 });
        return {
          status: 200,
          body: {
            workspaceId: ws.id,
            domainId: ws.domainId,
            revision: ws.revision,
            cursor: ws.sequence,
            snapshot: ws.snapshot,
            lifecycle: ws.lifecycle,
            messages,
          },
        };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    /** User chat turn: durable + idempotent. Atomically accepts message and schedules run intent. */
    async sendMessage(
      ownerId: string,
      workspaceId: string,
      requestId: string | undefined,
      input: unknown
    ): Promise<HandlerResult> {
      try {
        const body = sendMessageSchema.parse(input);
        const { message, sequence, run } = await deps.repo.appendMessage({
          workspaceId,
          ownerId,
          id: body.id,
          role: 'user',
          parts: body.parts,
          requestId,
        });
        return { status: 202, body: { message, cursor: sequence, runId: run?.id } };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async runAssistant(ownerId: string, workspaceId: string): Promise<HandlerResult> {
      try {
        // Schedule run if none active (idempotent at repository level)
        const run = await deps.repo.scheduleRun({ workspaceId, ownerId });
        if (deps.runAssistant) {
          return await deps.runAssistant(ownerId, workspaceId);
        }
        return { status: 200, body: { run } };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async cancelRun(
      ownerId: string,
      workspaceId: string,
      runId: string,
      input?: unknown
    ): Promise<HandlerResult> {
      try {
        const reason = input ? cancelRunSchema.parse(input).reason : undefined;
        const ok = await deps.repo.cancelRun({ runId, workspaceId, ownerId, reason });
        if (!ok) {
          return {
            status: 404,
            body: { code: 'RUN_NOT_FOUND', message: 'Run not found or already terminal', retryable: false },
          };
        }
        return { status: 200, body: { canceled: true } };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async getActiveRun(ownerId: string, workspaceId: string): Promise<HandlerResult> {
      try {
        const run = await deps.repo.getActiveRun({ workspaceId, ownerId });
        return { status: 200, body: { run } };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async getRun(ownerId: string, workspaceId: string, runId: string): Promise<HandlerResult> {
      try {
        const run = await deps.repo.getRun({ runId, workspaceId });
        if (!run) {
          return { status: 404, body: { code: 'RUN_NOT_FOUND', message: 'Run not found', retryable: false } };
        }
        return { status: 200, body: { run } };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async decideProposal(
      ownerId: string,
      workspaceId: string,
      proposalId: string,
      input: unknown
    ): Promise<HandlerResult> {
      try {
        const { decision } = decideProposalSchema.parse(input);
        const proposal = await deps.repo.resolveProposal({
          proposalId,
          workspaceId,
          ownerId,
          decision,
          decisionActor: ownerId,
        });
        return { status: 200, body: { proposal } };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async listProposals(ownerId: string, workspaceId: string, state?: string): Promise<HandlerResult> {
      try {
        const proposals = await deps.repo.listProposals({ workspaceId, ownerId, state });
        return { status: 200, body: { proposals } };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async listMessages(ownerId: string, workspaceId: string, beforeSequence?: number): Promise<HandlerResult> {
      try {
        return {
          status: 200,
          body: {
            messages: await deps.repo.listMessages({ workspaceId, ownerId, beforeSequence, limit: 50 }),
          },
        };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    /** Single action path shared by UI and model tool dispatch. */
    async commitAction(ownerId: string, requestId: string | undefined, input: unknown): Promise<HandlerResult> {
      try {
        const envelope = actionEnvelopeSchema.parse(input);
        const ws = await deps.repo.loadWorkspace({ workspaceId: envelope.workspaceId, ownerId });
        if (!ws) return toErrorResult(new Error('WORKSPACE_NOT_FOUND'));
        const domain = deps.domains.get(ws.domainId);
        if (!domain) return toErrorResult(new Error('UNKNOWN_DOMAIN'));
        const res = await deps.repo.commitAction({
          workspaceId: ws.id,
          ownerId,
          expectedRevision: envelope.expectedRevision,
          envelope,
          plan: domain.plan,
          requestId,
        });
        return {
          status: 200,
          body: {
            revision: res.revision,
            cursor: res.sequence,
            receipt: res.receipt,
            snapshot: res.state,
          },
        };
      } catch (e) {
        return toErrorResult(e);
      }
    },

    async getEvents(ownerId: string, workspaceId: string, after = 0): Promise<HandlerResult> {
      try {
        const events = await deps.repo.queryEvents({ workspaceId, ownerId, afterSequence: after });
        return { status: 200, body: { events } };
      } catch (e) {
        return toErrorResult(e);
      }
    },
  };
}
