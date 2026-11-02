/**
 * @module interaction-builder/core/progress-ux
 *
 * Portable, deterministic UX primitives for conversational AI workspaces:
 * 1. Variable-length (2–5 steps) seeded AI thought-trail & step generators (`buildVariedSteps`, `buildVariedSearchSteps`, `buildVariedTurnSteps`)
 * 2. Multi-variant conversational outcome summaries (`buildVariedOutcomeSummary`)
 * 3. Chronological activity bubble message anchoring (`resolveActivityAnchorMessageId`, `isAnchoredBubbleAtConversationEnd`)
 * 4. Client-side implicit natural-language intent detection (`createImplicitActionDetector`)
 * 5. Delayed split-canvas reveal controller ("Tadada~" transition) (`resolveSplitCanvasLayout`)
 * 6. Stage-aware contextual suggestion chips (`createStageSuggestions`)
 */
export interface InteractionProgressStep {
    id: string;
    label: string;
    state: 'pending' | 'running' | 'complete';
}
/**
 * Deterministic 32-bit FNV-1a hash for stable step count & copy selection
 * without flickering across React re-renders.
 */
export declare function hashSeed(input: string): number;
export declare function pickDeterministic<T>(items: readonly T[], seed: number, offset?: number): T;
export declare function formatShortTopic(raw?: string, maxLength?: number): string | null;
export declare function pickStepCount(seed: number, allowedCounts?: readonly (2 | 3 | 4 | 5)[]): 2 | 3 | 4 | 5;
export interface FiveStagePools {
    stage1: readonly string[];
    stage2: readonly string[];
    stage3: readonly string[];
    stage4: readonly string[];
    stage5: readonly string[];
}
export interface BuildVariedStepsOptions {
    /** Seed string (e.g., query + goal + runId/intentVersion) so steps stay stable across re-renders */
    seedKey: string;
    /** Optional topic snippet interpolated into `{{topic}}` placeholders */
    topic?: string;
    /** Whether the operation is still in progress (`true`) or finished (`false` -> all steps complete) */
    isActive: boolean;
    /** Current 0-based or 1-based phase index from `useStepProgression` */
    activePhaseIndex: number;
    /** Minimum index that can be `'running'` while `isActive` is true (default `0`, use `1` when step 0 starts completed) */
    minRunningIndex?: number;
    /** Prefix for generated step IDs */
    idPrefix?: string;
    /** Optional custom 5-stage pools; falls back to general conversational reasoning pools */
    pools?: FiveStagePools;
    /** Optional custom allowed step counts (subset/sequence of 2, 3, 4, 5) */
    allowedCounts?: readonly (2 | 3 | 4 | 5)[];
}
/**
 * Generic variable-length (2–5 steps) deterministic step builder usable by any domain/site.
 */
export declare function buildVariedSteps({ seedKey, topic, isActive, activePhaseIndex, minRunningIndex, idPrefix, pools, allowedCounts, }: BuildVariedStepsOptions): InteractionProgressStep[];
export interface VariedSearchStepsOptions {
    goal?: string;
    query?: string;
    intentVersion?: number;
    isSearching: boolean;
    activePhaseIndex: number;
    /** Optional noun for what is being searched (default: `'cohorts'`, e.g. `'templates'`, `'projects'`, `'workflows'`) */
    resourcePlural?: string;
}
export declare function buildVariedSearchSteps({ goal, query, intentVersion, isSearching, activePhaseIndex, resourcePlural, }: VariedSearchStepsOptions): InteractionProgressStep[];
export interface VariedTurnStepsOptions {
    latestUserText: string;
    goal?: string;
    step?: string;
    hasLessons?: boolean;
    runId?: string | null;
    activePhaseIndex: number;
}
export declare function buildVariedTurnSteps({ latestUserText, goal, step, hasLessons, runId, activePhaseIndex, }: VariedTurnStepsOptions): InteractionProgressStep[];
export interface VariedSearchSummaryOptions {
    goal?: string;
    step?: string;
    status?: string;
    matchCount: number;
    intentVersion?: number;
    isSearching: boolean;
    /** Optional custom CTA label (default: `'Create your own cohort'`) */
    createCtaLabel?: string;
    /** Optional singular/plural resource noun (default: `'cohort'` / `'cohorts'`) */
    resourceSingular?: string;
    resourcePlural?: string;
}
export declare function buildVariedSearchSummary({ goal, step, status, matchCount, intentVersion, isSearching, createCtaLabel, resourceSingular, resourcePlural, }: VariedSearchSummaryOptions): string | null;
/**
 * Checks whether `messages[0]` is an initial user intake prompt that has no persisted
 * assistant reply row at `messages[1]` (e.g. search/discovery intake mode).
 */
export declare function hasUnansweredInitialUserPrompt(messages: ReadonlyArray<{
    id: string;
    role: string;
}>): boolean;
/**
 * Resolves the exact message ID after which an unpersisted search/activity bubble
 * should be anchored so follow-up messages and assistant replies always render
 * below it in true chronological order.
 */
export declare function resolveActivityAnchorMessageId(messages: ReadonlyArray<{
    id: string;
    role: string;
}>, showActivityBubble: boolean): string | null;
/**
 * Determines whether the anchored activity bubble sits at the very end of the conversation
 * (so next-step suggestions can be displayed once the activity finishes).
 */
export declare function isAnchoredBubbleAtConversationEnd(messages: ReadonlyArray<{
    id: string;
    role: string;
}>, showActivityBubble: boolean, anchorMessageId: string | null): boolean;
export interface ImplicitActionRule<Action, Stage = string> {
    id: string;
    /** Optional stage allowlist; if omitted, matches in any stage */
    allowedStages?: readonly Stage[];
    /** Ignore messages ending with `'?'` (default `true`) */
    ignoreQuestions?: boolean;
    /** One or more regexes; if any matches the trimmed message, `action` is returned */
    patterns: readonly RegExp[];
    action: Action | ((matchText: string) => Action);
}
/**
 * Creates a reusable client-side implicit intent detector that maps natural-language
 * user chat messages to immediate optimistic domain actions (such as popping open
 * a creation canvas or selecting a workflow branch).
 */
export declare function createImplicitActionDetector<Action, Stage = string>(rules: readonly ImplicitActionRule<Action, Stage>[]): (text: string, currentStage?: Stage) => Action | null;
export interface SplitCanvasLayoutOptions {
    /** Current stage/step identifier */
    stage?: string;
    /** Stages that should keep the chat centered in full-width mode (e.g. `['chat']`) */
    centeredStages?: readonly string[];
    /** Stage where async discovery/search runs before revealing the right panel (e.g. `'recommendations'`) */
    discoveryStage?: string;
    /** Status of the discovery/search payload (`undefined | 'queued' | 'running' | 'ready' | 'failed'`) */
    discoveryStatus?: string | null;
}
/**
 * Computes `'centered' | 'split'` layout state for the delayed "Tadada~" right-panel reveal.
 * Keeps the conversation centered during pure chat stages AND while discovery/search is still running,
 * flipping to `'split'` the exact moment discovery finishes or the user advances into a studio stage.
 */
export declare function resolveSplitCanvasLayout({ stage, centeredStages, discoveryStage, discoveryStatus, }: SplitCanvasLayoutOptions): 'centered' | 'split';
export interface InteractionSuggestion {
    id: string;
    label: string;
    prompt: string;
}
export type StageSuggestionMap<Stage extends string, Context = Record<string, unknown>> = {
    [K in Stage]?: readonly InteractionSuggestion[] | ((ctx: Context) => readonly InteractionSuggestion[]);
} & {
    default?: readonly InteractionSuggestion[] | ((ctx: Context) => readonly InteractionSuggestion[]);
};
/**
 * Creates a reusable stage-aware suggestion chip resolver for any conversational workspace.
 */
export declare function createStageSuggestions<Stage extends string, Context = Record<string, unknown>>(map: StageSuggestionMap<Stage, Context>, maxSuggestions?: number): (stage: Stage | undefined, ctx: Context) => InteractionSuggestion[];
//# sourceMappingURL=progress-ux.d.ts.map