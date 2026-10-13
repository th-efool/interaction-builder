import { describe, expect, it } from 'vitest';
import * as Root from '../src/index';
import * as Core from '../src/core/index';
import * as Runtime from '../src/runtime/index';
import * as Client from '../src/client/index';
import * as ReactLayer from '../src/react/index';
import * as PgAdapter from '../src/adapters/pg/index';
import * as HttpAdapter from '../src/adapters/http/index';
import * as AiAdapter from '../src/adapters/ai/index';
import * as Testkit from '../src/testkit/index';

describe('Authoritative Contract Snapshot & Zero-Breaking-Change Guarantee', () => {
  it('freezes public Root export signatures', () => {
    // Root re-exports core, runtime, client
    expect(typeof Root.entityRefSchema).toBe('object');
    expect(typeof Root.actionEnvelopeSchema).toBe('object');
    expect(typeof Root.planActionCommit).toBe('function');
    expect(typeof Root.createInteractionHandlers).toBe('function');
    expect(typeof Root.createInteractionStore).toBe('function');
    expect(typeof Root.createHttpTransport).toBe('function');
    expect(typeof Root.parseSseStream).toBe('function');
    expect(typeof Root.generateJsonPatch).toBe('function');
    expect(typeof Root.applyJsonPatch).toBe('function');
    expect(typeof Root.planBatchActionCommit).toBe('function');
  });

  it('freezes public Core export signatures', () => {
    expect(typeof Core.entityRefSchema).toBe('object');
    expect(typeof Core.changeReceiptSchema).toBe('object');
    expect(typeof Core.messagePartSchema).toBe('object');
    expect(typeof Core.interactionMessageSchema).toBe('object');
    expect(typeof Core.interactionEventSchema).toBe('object');
    expect(typeof Core.actionEnvelopeSchema).toBe('object');
    expect(typeof Core.reduceInteraction).toBe('function');
    expect(typeof Core.generateJsonPatch).toBe('function');
    expect(typeof Core.applyJsonPatch).toBe('function');

    // Schema structure verification
    expect(Core.entityRefSchema.safeParse({ kind: 'lesson', id: 'l1', version: 1 }).success).toBe(true);
    expect(Core.entityRefSchema.safeParse({ kind: '', id: 'l1', version: 1 }).success).toBe(false);
  });

  it('freezes public Runtime export signatures', () => {
    expect(typeof Runtime.planActionCommit).toBe('function');
    expect(typeof Runtime.planBatchActionCommit).toBe('function');
    expect(typeof Runtime.createInteractionHandlers).toBe('function');
    expect(typeof Runtime.runAssistantTurn).toBe('function');
    expect(typeof Runtime.deterministicUuid).toBe('function');
    expect(typeof Runtime.MemoryInteractionRepository).toBe('function');
    expect(typeof Runtime.streamEvents).toBe('function');
    expect(typeof Runtime.computePayloadHash).toBe('function');
  });

  it('freezes public Client export signatures', () => {
    expect(typeof Client.createInteractionStore).toBe('function');
    expect(typeof Client.createHttpTransport).toBe('function');
    expect(typeof Client.parseSseStream).toBe('function');
    expect(typeof Client.TransportError).toBe('function');
  });

  it('freezes public React export signatures', () => {
    expect(typeof ReactLayer.InteractionProvider).toBe('function');
    expect(typeof ReactLayer.useInteractionStore).toBe('function');
    expect(typeof ReactLayer.useInteractionState).toBe('function');
    expect(typeof ReactLayer.useInteractionSelector).toBe('function');
    expect(typeof ReactLayer.useWorkspaceView).toBe('function');
    expect(typeof ReactLayer.useWorkspaceMessages).toBe('function');
    expect(typeof ReactLayer.useWorkspaceConnection).toBe('function');
    expect(typeof ReactLayer.useWorkspacePending).toBe('function');
    expect(typeof ReactLayer.useDispatchAction).toBe('function');
    expect(typeof ReactLayer.useSendMessage).toBe('function');
    expect(typeof ReactLayer.useRunAssistant).toBe('function');
  });

  it('freezes public Adapter export signatures', () => {
    expect(typeof PgAdapter.createPgInteractionRepository).toBe('function');
    expect(typeof HttpAdapter.dispatchInteraction).toBe('function');
    expect(typeof AiAdapter.createAiSdkModelAdapter).toBe('function');
  });

  it('freezes public Testkit export signatures', () => {
    expect(typeof Testkit.agendaDomain).toBe('object');
    expect(typeof Testkit.sampleAgenda).toBe('object');
    expect(typeof Testkit.MemoryInteractionRepository).toBe('function');
    expect(typeof Testkit.createScriptedModelAdapter).toBe('function');
    expect(typeof Testkit.createScriptedLanguageModel).toBe('function');
  });
});
