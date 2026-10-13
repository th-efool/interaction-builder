import type { StoreState } from '../client/store';
import type { EntityRef } from '../core/contracts';
export declare function useInteractionState<View = unknown>(): StoreState<View>;
export declare function useWorkspaceView<View = unknown>(): View;
export declare function useWorkspaceMessages(): {
    id: string;
    role: "user" | "assistant" | "system";
    parts: ({
        type: "text";
        text: string;
    } | {
        type: "entity_ref";
        entity: {
            kind: string;
            id: string;
            version: number;
        };
        label: string;
    } | {
        type: "activity";
        status: "queued" | "running" | "waiting" | "done" | "failed";
        text: string;
    } | {
        type: "change_receipt";
        receipt: {
            receiptId: string;
            actionId: string;
            revision: number;
            summary: string;
            changed: {
                kind: string;
                id: string;
                version: number;
            }[];
            undoable: boolean;
        };
    } | {
        type: "warning";
        text: string;
    })[];
    sequence: number;
    runId: string | null;
}[];
export declare function useWorkspaceConnection(): "connecting" | "live" | "reconnecting" | "reset_required";
export declare function useWorkspacePending(): Record<string, "failed" | "pending">;
export declare function useDispatchAction<Action = unknown>(): (action: Action, entityVersions?: EntityRef[]) => Promise<boolean>;
export declare function useSendMessage(): (text: string, entityRefs?: Array<{
    entity: EntityRef;
    label: string;
}>) => Promise<boolean>;
export declare function useRunAssistant(): () => Promise<boolean>;
//# sourceMappingURL=hooks.d.ts.map