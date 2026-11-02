import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInteractionState, useWorkspaceMessages } from './hooks';
import {
  hasUnansweredInitialUserPrompt,
  isAnchoredBubbleAtConversationEnd,
  resolveActivityAnchorMessageId,
  type InteractionProgressStep,
} from '../core/progress-ux';

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

const DEFAULT_LIST_STYLE: React.CSSProperties = {
  listStyle: 'none',
  margin: '2px 0 11px 2px',
  padding: '2px 0 2px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '7px',
  borderLeft: '1.5px solid var(--ib-step-line, rgba(130, 140, 160, 0.28))',
};

function getDefaultItemStyle(state: InteractionProgressStep['state']): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: 0,
    fontSize: '12.75px',
    lineHeight: 1.35,
    opacity: state === 'pending' ? 0.52 : 1,
    fontWeight: state === 'running' ? 560 : state === 'complete' ? 480 : 400,
    color:
      state === 'running'
        ? 'var(--ib-step-ink, #08143d)'
        : 'var(--ib-step-muted, #5d6f8c)',
    transition: 'color 0.2s ease, opacity 0.2s ease',
  };
}

function getDefaultMarkerStyle(state: InteractionProgressStep['state']): React.CSSProperties {
  return {
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    border:
      state === 'pending'
        ? '1.25px solid rgba(93, 111, 140, 0.38)'
        : '1.25px solid rgba(48, 60, 255, 0.30)',
    background:
      state === 'pending'
        ? 'transparent'
        : 'rgba(48, 60, 255, 0.11)',
    color: 'var(--ib-step-accent, #303cff)',
  };
}

/**
 * Borderless inline vertical AI thought-trail & progress stepper component.
 * Works zero-config with built-in inline styles or with custom host CSS modules via `classNames`.
 */
export function InteractionStepTrail({
  steps,
  ariaLabel = 'Assistant progress steps',
  classNames,
  useDefaultInlineStyles = !classNames?.list,
}: InteractionStepTrailProps) {
  return (
    <ol
      className={classNames?.list}
      style={useDefaultInlineStyles ? DEFAULT_LIST_STYLE : undefined}
      aria-label={ariaLabel}
    >
      {steps.map(item => (
        <li
          key={item.id}
          className={classNames?.item}
          style={useDefaultInlineStyles ? getDefaultItemStyle(item.state) : undefined}
          data-step-state={item.state}
          aria-current={item.state === 'running' ? 'step' : undefined}
        >
          <span
            className={classNames?.marker}
            style={useDefaultInlineStyles ? getDefaultMarkerStyle(item.state) : undefined}
            aria-hidden="true"
          >
            {item.state === 'complete' ? (
              <svg
                width={10}
                height={10}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={classNames?.checkIcon}
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : item.state === 'running' ? (
              <svg
                width={12}
                height={12}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={classNames?.spinnerIcon}
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <span
                className={classNames?.pendingDot}
                style={
                  useDefaultInlineStyles
                    ? {
                        width: '4.5px',
                        height: '4.5px',
                        borderRadius: '50%',
                        background: 'rgba(93, 111, 140, 0.45)',
                      }
                    : undefined
                }
              />
            )}
          </span>
          <span
            className={classNames?.label}
            style={useDefaultInlineStyles ? { margin: 0 } : undefined}
          >
            {item.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

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

const DEFAULT_TURN_DELAYS = [500, 1150, 1850, 2600] as const;

/**
 * Multi-phase progression timer hook for 2–5 step checklists.
 */
export function useStepProgression(
  isActive: boolean,
  options?: UseStepProgressionOptions
): number {
  const startPhase = options?.startPhase ?? 0;
  const completedPhase = options?.completedPhase ?? 5;
  const delays = options?.delaysMs ?? DEFAULT_TURN_DELAYS;
  const resetKey = options?.resetKey;

  const [phase, setPhase] = useState<number>(() => (isActive ? startPhase : completedPhase));

  useEffect(() => {
    if (!isActive) {
      setPhase(completedPhase);
      return;
    }
    setPhase(startPhase);
    const timers = delays.map((ms, idx) =>
      setTimeout(() => {
        setPhase(startPhase + idx + 1);
      }, ms)
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [isActive, resetKey, startPhase, completedPhase, delays]);

  return phase;
}

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
export function useAnchoredActivityBubble(showBubble: boolean): UseAnchoredActivityBubbleResult {
  const messages = useWorkspaceMessages();
  const latestMessage = messages.at(-1);

  const hasUnansweredInitialPrompt = useMemo(
    () => hasUnansweredInitialUserPrompt(messages),
    [messages]
  );

  const anchorMessageId = useMemo(
    () => resolveActivityAnchorMessageId(messages, showBubble),
    [messages, showBubble]
  );

  const isBubbleAtEnd = useMemo(
    () => isAnchoredBubbleAtConversationEnd(messages, showBubble, anchorMessageId),
    [messages, showBubble, anchorMessageId]
  );

  const isLatestUser = latestMessage?.role === 'user' && !isBubbleAtEnd;

  const shouldRenderAfterMessage = useCallback(
    (messageId: string) => showBubble && anchorMessageId === messageId,
    [showBubble, anchorMessageId]
  );

  const shouldRenderStandalone = showBubble && !anchorMessageId;

  return {
    anchorMessageId,
    isBubbleAtEnd,
    isLatestUser,
    hasUnansweredInitialPrompt,
    shouldRenderAfterMessage,
    shouldRenderStandalone,
  };
}

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
export function useAssistantActivity(options?: UseAssistantActivityOptions) {
  const state = useInteractionState();
  const [turns, setTurns] = useState<AssistantTurnActivityItem[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const etagRef = useRef<string | null>(null);
  const currentWorkspaceIdRef = useRef(state?.workspaceId);

  const fastPollMs = options?.fastPollMs ?? 2000;
  const idlePollMs = options?.idlePollMs ?? 20000;
  const buildActivityUrl =
    options?.activityUrl ??
    ((wsId: string) => `/api/interaction/v1/workspaces/${wsId}/activity`);
  const buildCancelUrl =
    options?.cancelUrl ??
    ((wsId: string, runId: string) => `/api/interaction/v1/workspaces/${wsId}/runs/${runId}/cancel`);

  if (currentWorkspaceIdRef.current !== state?.workspaceId) {
    currentWorkspaceIdRef.current = state?.workspaceId;
    etagRef.current = null;
  }

  useEffect(() => {
    if (!state?.workspaceId) return;

    const controller = new AbortController();
    let active = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let currentDelay = fastPollMs;

    const scheduleNext = (delay: number) => {
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      timer = setTimeout(() => {
        void refresh();
      }, delay);
    };

    const refresh = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (active) return;
      active = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      try {
        const headers: Record<string, string> = {};
        if (etagRef.current) headers['If-None-Match'] = etagRef.current;

        const response = await fetch(buildActivityUrl(state.workspaceId), {
          cache: 'no-store',
          signal: controller.signal,
          headers,
        });

        if (response.status === 304) {
          if (!controller.signal.aborted) {
            setUnavailable(false);
            scheduleNext(currentDelay);
          }
          return;
        }

        if (!response.ok) throw new Error('ACTIVITY_UNAVAILABLE');

        const etag = response.headers.get('ETag') || response.headers.get('etag');
        if (etag) etagRef.current = etag;

        const body = await response.json();
        if (!controller.signal.aborted) {
          const nextTurns: AssistantTurnActivityItem[] = body.turns ?? [];
          setTurns(nextTurns);
          setUnavailable(false);
          const hasActiveRun = nextTurns.some(
            t => t.status === 'pending' || t.status === 'running' || t.status === 'queued'
          );
          currentDelay = hasActiveRun ? fastPollMs : idlePollMs;
          scheduleNext(currentDelay);
        }
      } catch {
        if (!controller.signal.aborted) {
          setUnavailable(true);
          scheduleNext(currentDelay);
        }
      } finally {
        active = false;
      }
    };

    const onVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        void refresh();
      } else if (document.visibilityState === 'hidden' && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    void refresh();

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [state?.workspaceId, state?.sequence, fastPollMs, idlePollMs]);

  const activeTurn = useMemo(
    () => turns.find(t => t.status === 'running' || t.status === 'queued') ?? null,
    [turns]
  );

  const hasActiveTurn = useMemo(
    () =>
      turns.some(t => t.status === 'pending' || t.status === 'queued' || t.status === 'running') ||
      !!activeTurn,
    [turns, activeTurn]
  );

  const queuedCount = useMemo(
    () => turns.filter(t => t.status === 'pending').length,
    [turns]
  );

  const cancelActiveTurn = useCallback(
    async (reason = 'Stopped by user') => {
      if (!state?.workspaceId || !activeTurn?.runId) return false;
      const response = await fetch(buildCancelUrl(state.workspaceId, activeTurn.runId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!response.ok) {
        throw new Error('Could not stop assistant; retry.');
      }
      return true;
    },
    [state?.workspaceId, activeTurn?.runId]
  );

  return {
    turns,
    unavailable,
    activeTurn,
    hasActiveTurn,
    queuedCount,
    cancelActiveTurn,
  };
}
