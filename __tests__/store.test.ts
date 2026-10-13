import { describe, expect, it } from 'vitest';
import { createInteractionStore, TransportError, type InteractionTransport } from '../src/client/store';

const WS = '4f828a1c-3b09-42b7-8738-4e50257ad42f';
type V = { intent: string };
const committed = (sequence: number, revision: number) => ({
  protocolVersion: 1,
  eventId: crypto.randomUUID(),
  workspaceId: WS,
  sequence,
  type: 'workspace.committed',
  revision,
  payload: {},
});
const tick = () => new Promise(r => setTimeout(r, 0));

function fake(init: { revision: number; cursor: number; v: V }) {
  let server = { ...init };
  let emit: (e: unknown) => void = () => undefined;
  let close: () => void = () => undefined;
  let opened: number[] = [];
  let commitImpl: (env: any) => Promise<any> = async env => {
    server = { revision: server.revision + 1, cursor: server.cursor + 1, v: { intent: env.action.intent } };
    return { revision: server.revision, cursor: server.cursor, snapshot: server.v, receipt: { receiptId: 'r', summary: 'ok' } };
  };
  const t: InteractionTransport<V> = {
    getWorkspace: async () => ({ workspaceId: WS, revision: server.revision, cursor: server.cursor, snapshot: server.v }),
    commit: env => commitImpl(env),
    openEvents: (cursor, onEvent, onClose) => {
      opened.push(cursor);
      emit = onEvent;
      close = onClose;
      return () => undefined;
    },
  };
  return {
    t,
    srv: () => server,
    setServer: (s: typeof server) => {
      server = s;
    },
    emit: (e: unknown) => emit(e),
    end: () => close(),
    opened,
    setCommit: (f: typeof commitImpl) => {
      commitImpl = f;
    },
  };
}

describe('interaction store', () => {
  it('connect loads snapshot and opens stream at cursor', async () => {
    const f = fake({ revision: 3, cursor: 7, v: { intent: 'a' } });
    const s = createInteractionStore<V>({ workspaceId: WS, initialView: { intent: '' }, transport: f.t });
    await s.connect();
    expect(s.getState().view.intent).toBe('a');
    expect(s.getState().revision).toBe(3);
    expect(f.opened).toEqual([7]);
  });

  it('own action applies authoritative view; own SSE echo is ignored (no refetch)', async () => {
    const f = fake({ revision: 0, cursor: 0, v: { intent: 'a' } });
    const s = createInteractionStore<V>({ workspaceId: WS, initialView: { intent: '' }, transport: f.t });
    await s.connect();
    expect(await s.dispatchAction({ type: 'set_intent', intent: 'b' })).toBe(true);
    expect(s.getState().view.intent).toBe('b');
    f.emit(committed(1, 1));
    expect(s.getState().sequence).toBe(1);
    expect(s.getState().pending).toEqual({});
    expect(s.getState().lastReceipt?.summary).toBe('ok');
  });

  it('foreign commit (e.g. chat/other tab) triggers resnapshot so view updates', async () => {
    const f = fake({ revision: 0, cursor: 0, v: { intent: 'a' } });
    const s = createInteractionStore<V>({ workspaceId: WS, initialView: { intent: '' }, transport: f.t });
    await s.connect();
    f.setServer({ revision: 1, cursor: 1, v: { intent: 'from-chat' } });
    f.emit(committed(1, 1));
    await tick();
    await tick();
    expect(s.getState().view.intent).toBe('from-chat');
    expect(s.getState().revision).toBe(1);
  });

  it('gap forces resnapshot then stream reopen; duplicate ignored', async () => {
    const f = fake({ revision: 0, cursor: 0, v: { intent: 'a' } });
    const s = createInteractionStore<V>({ workspaceId: WS, initialView: { intent: '' }, transport: f.t });
    await s.connect();
    f.setServer({ revision: 3, cursor: 3, v: { intent: 'later' } });
    f.emit(committed(3, 3)); // gap (expected 1)
    await tick();
    await tick();
    await tick();
    expect(s.getState().view.intent).toBe('later');
    expect(f.opened.length).toBe(2);
    const seq = s.getState().sequence;
    f.emit(committed(seq, 3));
    expect(s.getState().sequence).toBe(seq);
  });

  it('conflict marks failed, keeps error, resnapshots', async () => {
    const f = fake({ revision: 0, cursor: 0, v: { intent: 'a' } });
    const s = createInteractionStore<V>({ workspaceId: WS, initialView: { intent: '' }, transport: f.t });
    await s.connect();
    f.setCommit(async () => {
      f.setServer({ revision: 1, cursor: 1, v: { intent: 'other' } });
      throw new TransportError(409, 'CONFLICT');
    });
    expect(await s.dispatchAction({ type: 'set_intent', intent: 'x' })).toBe(false);
    await tick();
    await tick();
    expect(s.getState().lastError?.code).toBe('CONFLICT');
    expect(s.getState().view.intent).toBe('other');
  });

  it('stream close reconnects from latest cursor', async () => {
    const f = fake({ revision: 0, cursor: 0, v: { intent: 'a' } });
    const s = createInteractionStore<V>({
      workspaceId: WS,
      initialView: { intent: '' },
      transport: f.t,
      reconnectDelayMs: 1,
    });
    await s.connect();
    f.end();
    expect(s.getState().connection).toBe('reconnecting');
    await new Promise(r => setTimeout(r, 15));
    expect(f.opened.length).toBe(2);
    s.disconnect();
  });

  it('full browser journey: send message -> assistant edit -> manual UI edit -> next assistant sees it -> reload -> reconnect -> second-tab conflict', async () => {
    let server = { revision: 0, cursor: 0, v: { intent: 'initial' }, messages: [] as Array<{ id: string; text: string }> };
    const tab1Listeners: Array<(e: any) => void> = [];
    const tab2Listeners: Array<(e: any) => void> = [];

    const broadcast = (event: any) => {
      tab1Listeners.forEach(l => l(event));
      tab2Listeners.forEach(l => l(event));
    };

    const makeTransport = (listeners: Array<(e: any) => void>): InteractionTransport<V> => ({
      getWorkspace: async () => ({
        workspaceId: WS,
        revision: server.revision,
        cursor: server.cursor,
        snapshot: server.v,
      }),
      commit: async (env: any) => {
        if (env.expectedRevision !== server.revision) {
          throw new TransportError(409, 'CONFLICT');
        }
        server.revision += 1;
        server.cursor += 1;
        server.v = { intent: env.action.intent };
        const receipt = { receiptId: crypto.randomUUID(), summary: 'updated' };
        broadcast(committed(server.cursor, server.revision));
        return {
          revision: server.revision,
          cursor: server.cursor,
          snapshot: server.v,
          receipt,
        };
      },
      openEvents: (cursor, onEvent, onClose) => {
        listeners.push(onEvent);
        return () => {
          const idx = listeners.indexOf(onEvent);
          if (idx !== -1) listeners.splice(idx, 1);
        };
      },
      sendMessage: async (body: { id: string; parts: unknown[] }) => {
        server.cursor += 1;
        const msg = { id: body.id, text: (body.parts[0] as any).text };
        server.messages.push(msg);
        return { message: msg as any, cursor: server.cursor };
      },
    });

    const storeTab1 = createInteractionStore<V>({ workspaceId: WS, initialView: { intent: '' }, transport: makeTransport(tab1Listeners) });
    const storeTab2 = createInteractionStore<V>({ workspaceId: WS, initialView: { intent: '' }, transport: makeTransport(tab2Listeners) });

    // Both tabs connect
    await storeTab1.connect();
    await storeTab2.connect();
    expect(storeTab1.getState().view.intent).toBe('initial');
    expect(storeTab2.getState().view.intent).toBe('initial');

    // 1. User sends message in Tab 1
    const sendOk = await storeTab1.sendMessage([{ type: 'text', text: 'Please refine intent' }]);
    expect(sendOk).toBe(true);

    // 2. Assistant edits workspace on server
    server.revision += 1;
    server.cursor += 1;
    server.v = { intent: 'Assistant refined intent' };
    broadcast(committed(server.cursor, server.revision));
    await tick();
    await tick();

    // Both tabs reflect assistant edit
    expect(storeTab1.getState().view.intent).toBe('Assistant refined intent');
    expect(storeTab2.getState().view.intent).toBe('Assistant refined intent');
    expect(storeTab1.getState().revision).toBe(1);
    expect(storeTab2.getState().revision).toBe(1);

    // 3. User manually edits UI in Tab 1
    const manualEditOk = await storeTab1.dispatchAction({ type: 'set_intent', intent: 'Manual user override' });
    expect(manualEditOk).toBe(true);
    expect(storeTab1.getState().view.intent).toBe('Manual user override');
    expect(storeTab1.getState().revision).toBe(2);

    // Tab 2 receives the event and resnapshots
    await tick();
    await tick();
    expect(storeTab2.getState().view.intent).toBe('Manual user override');
    expect(storeTab2.getState().revision).toBe(2);

    // 4. Next assistant sees the manual edit
    expect(server.v.intent).toBe('Manual user override');
    expect(server.revision).toBe(2);

    // 5. Reload Tab 1: disconnect and reconnect
    storeTab1.disconnect();
    await storeTab1.connect();
    expect(storeTab1.getState().connection).toBe('live');
    expect(storeTab1.getState().view.intent).toBe('Manual user override');
    expect(storeTab1.getState().revision).toBe(2);

    // 6. Second-tab conflict: Tab 2 attempts commit with stale revision
    const staleTransport: InteractionTransport<V> = {
      ...makeTransport(tab2Listeners),
      commit: async () => {
        throw new TransportError(409, 'CONFLICT');
      },
    };
    const storeTab2Stale = createInteractionStore<V>({ workspaceId: WS, initialView: { intent: '' }, transport: staleTransport });
    await storeTab2Stale.connect();
    const conflictResult = await storeTab2Stale.dispatchAction({ type: 'set_intent', intent: 'Stale tab 2 edit' });
    expect(conflictResult).toBe(false);
    expect(storeTab2Stale.getState().lastError?.code).toBe('CONFLICT');

    storeTab1.disconnect();
    storeTab2.disconnect();
    storeTab2Stale.disconnect();
  });
});
