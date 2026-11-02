import React from 'react';
import { type InteractionProgressStep } from '../core/progress-ux';
export interface InteractionStepTrailClassNames {
    list?: string;
    item?: string;
    marker?: string;
    label?: string;
    checkIcon?: string;
    spinnerIcon?: string;
    pendingDot?: string;
}
export interface InteractionStepTrailProps {
    steps: readonly InteractionProgressStep[];
    ariaLabel?: string;
    classNames?: InteractionStepTrailClassNames;
    /** Set to `false` when using custom CSS module classes that define all layout/colors */
    useDefaultInlineStyles?: boolean;
}
/**
 * Borderless inline vertical AI thought-trail & progress stepper component.
 * Works zero-config with built-in inline styles or with custom host CSS modules via `classNames`.
 */
export declare function InteractionStepTrail({ steps, ariaLabel, classNames, useDefaultInlineStyles, }: InteractionStepTrailProps): React.JSX.Element;
export interface UseStepProgressionOptions {
    /** Key that resets progression when changed (e.g. `runId` or `intentVersion`) */
    resetKey?: unknown;
    /** Initial phase index when `isActive` becomes true (default `0`, use `1` when step 0 starts complete) */
    startPhase?: number;
    /** Phase index when `isActive` is false (default `5`) */
    completedPhase?: number;
    /** Cumulative millisecond delays for advancing phases after `startPhase` */
    delaysMs?: readonly number[];
}
/**
 * Multi-phase progression timer hook for 2–5 step checklists.
 */
export declare function useStepProgression(isActive: boolean, options?: UseStepProgressionOptions): number;
export interface UseAnchoredActivityBubbleResult {
    anchorMessageId: string | null;
    isBubbleAtEnd: boolean;
    isLatestUser: boolean;
    hasUnansweredInitialPrompt: boolean;
    shouldRenderAfterMessage: (messageId: string) => boolean;
    shouldRenderStandalone: boolean;
}
/**
 * React hook that anchors an unpersisted search/discovery activity bubble to the exact
 * user message that triggered it (`messages[0]` for initial intake search), preventing
 * follow-up user prompts and assistant replies from appearing above the initial search response.
 */
export declare function useAnchoredActivityBubble(showBubble: boolean): UseAnchoredActivityBubbleResult;
export interface AssistantTurnActivityItem {
    messageId: string;
    runId: string | null;
    status: string;
}
export interface UseAssistantActivityOptions {
    /** Custom activity polling endpoint builder */
    activityUrl?: (workspaceId: string) => string;
    /** Custom run cancel endpoint builder */
    cancelUrl?: (workspaceId: string, runId: string) => string;
    fastPollMs?: number;
    idlePollMs?: number;
}
/**
 * Portable assistant turn activity poller and run cancellation hook.
 */
export declare function useAssistantActivity(options?: UseAssistantActivityOptions): {
    turns: AssistantTurnActivityItem[];
    unavailable: boolean;
    activeTurn: AssistantTurnActivityItem | null;
    hasActiveTurn: boolean;
    queuedCount: number;
    cancelActiveTurn: (reason?: string) => Promise<boolean>;
};
//# sourceMappingURL=progress-ui.d.ts.map