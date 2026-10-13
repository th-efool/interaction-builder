import { type InteractionClientState } from '../core/reducer';
import type { InteractionMessage } from '../core/contracts';
export interface WorkspaceSnapshot<View> {
    workspaceId: string;
    revision: number;
    cursor: number;
    snapshot: View;
    messages?: InteractionMessage[];
}
export interface CommitResponse<View> {
    revision: number;
    cursor: number;
    snapshot: View;
    receipt: {
        receiptId: string;
        summary: string;
    };
}
export declare class TransportError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string);
}
/** Host/transport-agnostic; default fetch implementation lives in transport.ts. */
export interface InteractionTransport<View> {
    getWorkspace(): Promise<WorkspaceSnapshot<View>>;
    commit(envelope: unknown, idempotencyKey: string): Promise<CommitResponse<View>>;
    sendMessage?(message: {
        id: string;
        parts: unknown[];
    }, idempotencyKey: string): Promise<{
        message: unknown;
        cursor: number;
    }>;
    runAssistant?(): Promise<{
        success: boolean;
        text?: string;
    }>;
    /** Open a bounded event stream after `cursor`. Returns closer. onClose fires when stream ends/fails. */
    openEvents(cursor: number, onEvent: (event: unknown) => void, onClose: () => void): () => void;
}
export interface StoreState<View> extends InteractionClientState<View> {
    lastReceipt: {
        actionId: string;
        summary: string;
    } | null;
    lastError: {
        actionId: string;
        code: string;
    } | null;
}
export interface InteractionStore<View> {
    getState(): StoreState<View>;
    subscribe(fn: () => void): () => void;
    connect(): Promise<void>;
    disconnect(): void;
    /** Same typed-action path the chat/tool loop uses server-side. Resolves with ok flag. */
    dispatchAction(action: unknown, entityVersions?: {
        kind: string;
        id: string;
        version: number;
    }[]): Promise<boolean>;
    sendMessage(parts: unknown[]): Promise<boolean>;
    runAssistant(): Promise<boolean>;
}
export declare function createInteractionStore<View>(opts: {
    workspaceId: string;
    initialView: View;
    transport: InteractionTransport<View>;
    newId?: () => string;
    reconnectDelayMs?: number;
}): InteractionStore<View>;
//# sourceMappingURL=store.d.ts.map