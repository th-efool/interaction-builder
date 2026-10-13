import type { InteractionRepository } from './repository';
import type { DomainDefinition } from './handlers';
import { computePayloadHash } from './repository';

export interface InteractionModelMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface InteractionModelTurnInput {
  systemPrompt: string;
  messages: InteractionModelMessage[];
  tools: Record<string, any>;
  maxSteps?: number;
}

export interface InteractionModelTurnOutput {
  text: string;
  stepsCount: number;
}

export interface InteractionModelAdapter {
  executeTurn(input: InteractionModelTurnInput): Promise<InteractionModelTurnOutput>;
}

export interface ToolStepMeta {
  ordinal: number;
  requestId: string;
}

export interface AssistantRunOptions<State = unknown> {
  workspaceId: string;
  ownerId: string;
  repo: InteractionRepository;
  domain: DomainDefinition<State>;
  model: InteractionModelAdapter;
  createTools: (deps: {
    workspaceId: string;
    ownerId: string;
    repo: InteractionRepository;
    domain: DomainDefinition<State>;
    observedRevision: number;
    runFence?: { runId: string; leaseToken: string };
    onToolStep?: (
      toolName: string,
      inputPayload: unknown,
      actionFn: (meta?: ToolStepMeta) => Promise<unknown>
    ) => Promise<unknown>;
  }) => Record<string, any>;
  runId?: string;
  leaseToken?: string;
  observedRevision?: number;
  maxSteps?: number;
  systemPrompt?: string;
}

export interface AssistantRunResult {
  success: boolean;
  assistantMessageId: string | null;
  text: string;
  stepsCount: number;
  runId?: string;
}

export async function runAssistantTurn<State>(
  opts: AssistantRunOptions<State>
): Promise<AssistantRunResult> {
  const { workspaceId, ownerId, repo, domain, model, runId, leaseToken } = opts;

  const ws = await repo.loadWorkspace<State>({ workspaceId, ownerId });
  if (!ws) throw new Error('WORKSPACE_NOT_FOUND');
  if (ws.lifecycle !== 'active') throw new Error('WORKSPACE_NOT_ACTIVE');

  let observedRevision = opts.observedRevision ?? ws.revision;
  if (runId) {
    const run = await repo.getRun({ runId, workspaceId });
    if (run) {
      if (run.status === 'canceled') throw new Error('RUN_CANCELED');
      observedRevision = run.observedRevision;
    }
  }

  const history = await repo.listMessages({ workspaceId, ownerId, limit: 20 });
  if (history.length === 0) {
    return { success: true, assistantMessageId: null, text: '', stepsCount: 0, runId };
  }

  // Format messages for the model adapter
  const modelMessages: InteractionModelMessage[] = [];
  for (const m of history) {
    let content = '';
    for (const part of m.parts as Array<{ type: string; text?: string; label?: string; entity?: { kind: string; id: string } }>) {
      if (part.type === 'text' && part.text) {
        content += (content ? '\n' : '') + part.text;
      } else if (part.type === 'entity_ref' && part.entity) {
        content += (content ? '\n' : '') + `[Selected entity: ${part.label ?? part.entity.id} (${part.entity.kind} id=${part.entity.id})]`;
      }
    }
    if (content.trim()) {
      if (m.role === 'user') {
        modelMessages.push({ role: 'user', content });
      } else if (m.role === 'assistant') {
        modelMessages.push({ role: 'assistant', content });
      }
    }
  }

  if (modelMessages.length === 0 || modelMessages[modelMessages.length - 1]?.role !== 'user') {
    return { success: true, assistantMessageId: null, text: '', stepsCount: 0, runId };
  }

  const defaultSystem = `You are an AI assistant collaborating with the user on this workspace.
Current workspace state:
${JSON.stringify(ws.snapshot, null, 2)}
Revision: ${observedRevision}

Instructions:
1. When the user asks for changes, call the provided tools to update the workspace.
2. Every tool call directly modifies the live workspace for the user.
3. Be concise and clear in your responses.`;

  const system = opts.systemPrompt ?? defaultSystem;

  // Load existing journal steps for replay recovery
  const journaledSteps = runId ? await repo.listSteps({ runId }) : [];
  let toolInvocationIndex = 0;
  let lastToolError: unknown = null;

  const onToolStep = async (
    toolName: string,
    inputPayload: unknown,
    actionFn: (meta?: ToolStepMeta) => Promise<unknown>
  ) => {
    toolInvocationIndex += 1;
    const currentOrdinal = toolInvocationIndex;
    const inputHash = computePayloadHash(inputPayload);
    const requestId = runId ? `step:${runId}:${currentOrdinal}` : undefined;

    // Check if step was previously recorded in this run
    const existing = journaledSteps.find(s => s.ordinal === currentOrdinal && s.kind === 'tool_call');
    if (existing) {
      if (existing.toolName !== toolName) {
        throw new Error(
          `DIVERGENT_REPLAY: Expected tool ${existing.toolName} at ordinal ${currentOrdinal}, received ${toolName}`
        );
      }
      if (existing.inputHash && existing.inputHash !== inputHash) {
        throw new Error(
          `DIVERGENT_REPLAY: Input hash mismatch for tool ${toolName} at ordinal ${currentOrdinal}`
        );
      }
      if (existing.state === 'completed' && existing.result !== undefined && existing.result !== null) {
        return existing.result;
      }
    }

    if (runId && leaseToken && !existing) {
      await repo.recordStep({
        runId,
        leaseToken,
        ordinal: currentOrdinal,
        kind: 'tool_call',
        toolName,
        inputHash,
        inputPayload,
        state: 'started',
        effectKey: requestId,
      });
    }

    try {
      const res = await actionFn({ ordinal: currentOrdinal, requestId: requestId ?? '' });
      if (runId && leaseToken) {
        await repo.recordStep({
          runId,
          leaseToken,
          ordinal: currentOrdinal,
          kind: 'tool_call',
          toolName,
          inputHash,
          inputPayload,
          state: 'completed',
          result: res,
          effectKey: requestId,
        });
      }
      return res;
    } catch (err: any) {
      lastToolError = err;
      if (runId && leaseToken) {
        await repo.recordStep({
          runId,
          leaseToken,
          ordinal: currentOrdinal,
          kind: 'tool_call',
          toolName,
          inputHash,
          inputPayload,
          state: 'failed',
          error: err.message ?? String(err),
          effectKey: requestId,
        });
      }
      throw err;
    }
  };

  const runFence = runId && leaseToken ? { runId, leaseToken } : undefined;

  const tools = opts.createTools({
    workspaceId,
    ownerId,
    repo,
    domain,
    observedRevision,
    runFence,
    onToolStep,
  });

  if (runId && leaseToken) {
    await repo.recordStep({
      runId,
      leaseToken,
      ordinal: 0,
      kind: 'model_call',
      state: 'started',
    });
  }

  if (!model || typeof model.executeTurn !== 'function') {
    throw new Error(
      'MODEL_ADAPTER_REQUIRED: model must implement InteractionModelAdapter. Wrap LanguageModel using createAiSdkModelAdapter.'
    );
  }

  let result: InteractionModelTurnOutput;
  try {
    result = await model.executeTurn({
      systemPrompt: system,
      messages: modelMessages,
      tools,
      maxSteps: opts.maxSteps,
    });

    if (lastToolError) {
      throw lastToolError;
    }

    if (runId && leaseToken) {
      await repo.recordStep({
        runId,
        leaseToken,
        ordinal: 0,
        kind: 'model_call',
        state: 'completed',
        result: { text: result.text, stepsCount: result.stepsCount },
      });
    }
  } catch (err: any) {
    if (runId && leaseToken) {
      await repo.recordStep({
        runId,
        leaseToken,
        ordinal: 0,
        kind: 'model_call',
        state: 'failed',
        error: err.message ?? String(err),
      });
    }
    throw err;
  }

  const responseText = result.text.trim();
  let assistantMessageId: string | null = null;

  if (responseText) {
    assistantMessageId = crypto.randomUUID();
    await repo.appendMessage({
      workspaceId,
      ownerId,
      id: assistantMessageId,
      role: 'assistant',
      parts: [{ type: 'text', text: responseText }],
      runId: runId ?? null,
    });
  }

  return {
    success: true,
    assistantMessageId,
    text: responseText,
    stepsCount: result.stepsCount,
    runId,
  };
}
