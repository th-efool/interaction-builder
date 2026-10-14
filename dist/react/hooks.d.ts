import type { StoreState } from '../client/store';
import type { EntityRef } from '../core/contracts';
export declare function useInteractionState<View = unknown>(): StoreState<View>;
/**
 * Selective subscription hook to prevent unnecessary re-renders.
 * Re-renders only when the selected slice of domain state changes.
 */
export declare function useInteractionSelector<View = unknown, Selected = unknown>(selector: (view: View) => Selected, isEqual?: (a: Selected, b: Selected) => boolean): Selected;
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
/**
 * Access time-travel history, undo/redo triggers, and revision navigation.
 */
export declare function useInteractionHistory<View = unknown>(): {
    undo: () => boolean;
    redo: () => boolean;
    timeTravel: (revision: number) => boolean;
    resetTimeTravel: () => void;
    past: import("..").HistoryEntry<View>[];
    future: import("..").HistoryEntry<View>[];
    canUndo: boolean;
    canRedo: boolean;
    isTimeTraveling: boolean;
    activeRevision: number;
};
/**
 * Check if the current browser tab is the active SSE Leader tab in cross-tab sync mode.
 */
export declare function useIsCrossTabLeader(): boolean;
//# sourceMappingURL=hooks.d.ts.map