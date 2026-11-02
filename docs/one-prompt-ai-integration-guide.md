# One-Prompt AI Integration Guide for `interaction-builder`

> **How to use this guide:** Copy the prompt block below (or point your AI coding agent—Claude Code, Cursor, Antigravity, Windsurf, or Codex—directly to this file) and tell it:
>
> `"Integrate interaction-builder into this project for my [DOMAIN_NAME] feature following packages/interaction-builder/docs/one-prompt-ai-integration-guide.md in one pass."`

---

## Copy-Paste One-Prompt Blueprint for Any Site

```markdown
You are integrating `interaction-builder` into this application to power a real-time, collaborative AI + User workspace with:
1. Deterministic state & optimistic UI updates (`DomainDefinition`, `InteractionProvider`, `useWorkspaceView`, `useDispatchAction`, `useSendMessage`)
2. Delayed Split-Canvas Reveal ("Tadada~" transition via `resolveSplitCanvasLayout`) — starts as a centered chat during initial discovery/search, and pops open the right-hand studio canvas the instant search results are ready or the user triggers creation.
3. Dynamic 2–5 Step Inline AI Thought-Trail (`<InteractionStepTrail />`, `useStepProgression`, `buildVariedSteps`, `buildVariedSearchSteps`, `buildVariedTurnSteps`, `buildVariedSearchSummary`) — borderless vertical timeline with deterministic FNV-1a seeded step counts (2, 3, 4, or 5 steps) and varied, topic-aware phrasing that never flickers on re-render.
4. Chronological Activity Bubble Anchoring (`useAnchoredActivityBubble` / `resolveActivityAnchorMessageId`) — anchors unpersisted search/discovery responses directly after the user message that triggered them (`messages[0]`) so follow-up user prompts and assistant replies always appear below in true chronological order.
5. Client-Side Implicit Intent Router (`createImplicitActionDetector`) — detects when a user's chat message asks to start/create/open a workspace or choose a branch, immediately dispatching the domain action optimistically alongside `sendMessage`.
6. Stage-Aware Suggestion Chips (`createStageSuggestions`) & Assistant Turn Activity (`useAssistantActivity`).

### Step 1: Define Domain State, Actions & Implicit Intent Rules (`domain.ts`)

Create your shared domain file importing from `interaction-builder/core`:

```ts
import { z } from 'zod';
import {
  createImplicitActionDetector,
  createStageSuggestions,
  type DomainDefinition,
} from 'interaction-builder/core';

export const workspaceSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  title: z.string().default('Untitled Workspace'),
  intent: z.string().default(''),
  stage: z.enum(['chat', 'recommendations', 'studio', 'review', 'ready']).default('chat'),
  discovery: z
    .object({
      status: z.enum(['queued', 'running', 'ready', 'failed']),
      items: z.array(z.object({ id: z.string(), title: z.string(), summary: z.string() })),
    })
    .optional(),
  items: z.array(
    z.object({
      id: z.string(),
      version: z.number().int().nonnegative().default(0),
      title: z.string(),
      notes: z.string().default(''),
    })
  ).default([]),
});

export type MyWorkspace = z.infer<typeof workspaceSchema>;

export type MyAction =
  | { type: 'open_studio' }
  | { type: 'set_title'; title: string }
  | { type: 'add_item'; title: string; notes?: string };

export const myDomain: DomainDefinition<MyWorkspace> = {
  id: 'my-workspace',
  version: 1,
  initialState: raw => workspaceSchema.parse(raw ?? {}),
  plan: (state, rawAction, ctx) => {
    if (ctx.expectedRevision !== ctx.currentRevision) {
      throw new Error('STALE_WORKSPACE');
    }
    const action = rawAction as MyAction;
    if (action.type === 'open_studio') {
      return {
        nextState: { ...state, stage: 'studio' },
        changed: [],
        invalidated: [],
        summary: 'Opened workspace studio',
        undoable: true,
      };
    }
    if (action.type === 'set_title') {
      return {
        nextState: { ...state, title: action.title },
        changed: [],
        invalidated: [],
        summary: `Renamed workspace to ${action.title}`,
        undoable: true,
      };
    }
    if (action.type === 'add_item') {
      const id = `item-${state.items.length + 1}`;
      return {
        nextState: {
          ...state,
          items: [...state.items, { id, version: 0, title: action.title, notes: action.notes ?? '' }],
        },
        changed: [{ kind: 'item', id, version: 0 }],
        invalidated: [],
        summary: `Added ${action.title}`,
        undoable: true,
      };
    }
    throw new Error('UNKNOWN_ACTION');
  },
};

export const detectImplicitWorkspaceAction = createImplicitActionDetector<MyAction, MyWorkspace['stage']>([
  {
    id: 'open-studio',
    allowedStages: ['chat', 'recommendations'],
    patterns: [
      /\b(?:create|start|build|make|launch|open)\s+(?:a\s+|an\s+|my\s+|our\s+|the\s+|own\s+)*(?:new\s+|custom\s+|own\s+)*(?:workspace|studio|project|cohort|board|plan)\b/i,
      /\bcreate\s+my\s+own\b/i,
      /\blet'?s\s+(?:start|build|create|make)\s+(?:it|this|one)\b/i,
    ],
    action: { type: 'open_studio' },
  },
]);

export const getWorkspaceSuggestions = createStageSuggestions<MyWorkspace['stage'], { goal?: string }>({
  chat: ctx => [
    { id: 'plan', label: 'Draft a roadmap', prompt: `Draft a structured plan for ${ctx.goal || 'my project'}` },
    { id: 'open', label: 'Open studio', prompt: 'Let’s build my own workspace in the studio' },
  ],
  recommendations: [
    { id: 'advanced', label: 'Advanced options', prompt: 'Show more advanced options' },
    { id: 'create_own', label: 'Create my own', prompt: 'I’ll create my own instead' },
  ],
  default: [
    { id: 'refine', label: 'Refine structure', prompt: 'Help me refine the current items' },
    { id: 'next', label: 'What next?', prompt: 'What should I do now?' },
  ],
});
```

### Step 2: Mount Server Runtime & HTTP Route Handler (`app/api/interaction/v1/[...path]/route.ts`)

Use `interaction-builder/runtime`, `interaction-builder/adapters/http`, and either `interaction-builder/adapters/pg` (PostgreSQL) or `interaction-builder/adapters/sqlite` / `MemoryInteractionRepository`:

```ts
import { createInteractionHttpHandler } from 'interaction-builder/adapters/http';
import { createPgInteractionRepository } from 'interaction-builder/adapters/pg';
import { myDomain } from '@/shared/domain';
import { pool } from '@/server/db';

const repo = createPgInteractionRepository({ pool, domain: myDomain });

const handler = createInteractionHttpHandler({
  repository: repo,
  domain: myDomain,
  resolvePrincipal: async req => {
    // Replace with your site's session auth resolver
    return { ownerId: req.headers.get('x-user-id') ?? 'anonymous-user' };
  },
});

export const GET = (req: Request) => handler(req);
export const POST = (req: Request) => handler(req);
```

### Step 3: Build the Split-Screen Conversational Workspace with Inline Step Trail & Chronological Anchoring (`WorkspaceScreen.tsx`)

Import the React primitives from `interaction-builder/react`:

```tsx
'use client';

import React, { useState } from 'react';
import {
  InteractionProvider,
  InteractionStepTrail,
  useAnchoredActivityBubble,
  useAssistantActivity,
  useDispatchAction,
  useSendMessage,
  useStepProgression,
  useWorkspaceMessages,
  useWorkspaceView,
  buildVariedSearchSteps,
  buildVariedSearchSummary,
  buildVariedTurnSteps,
  resolveSplitCanvasLayout,
} from 'interaction-builder/react';
import {
  detectImplicitWorkspaceAction,
  getWorkspaceSuggestions,
  type MyAction,
  type MyWorkspace,
} from '@/shared/domain';

export function WorkspaceScreen({
  workspaceId,
  initialView,
}: {
  workspaceId: string;
  initialView: MyWorkspace;
}) {
  return (
    <InteractionProvider workspaceId={workspaceId} initialView={initialView}>
      <WorkspaceShell />
    </InteractionProvider>
  );
}

function WorkspaceShell() {
  const view = useWorkspaceView<MyWorkspace>();
  const layout = resolveSplitCanvasLayout({
    stage: view.stage,
    centeredStages: ['chat'],
    discoveryStage: 'recommendations',
    discoveryStatus: view.discovery?.status,
  });

  return (
    <div data-layout={layout} style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{ width: layout === 'centered' ? '100%' : '400px', transition: 'width 0.28s ease' }}>
        <ChatRail />
      </aside>
      {layout === 'split' && (
        <main style={{ flex: 1 }}>
          <StudioCanvas />
        </main>
      )}
    </div>
  );
}

function ChatRail() {
  const view = useWorkspaceView<MyWorkspace>();
  const messages = useWorkspaceMessages();
  const sendMessage = useSendMessage();
  const dispatchAction = useDispatchAction<MyAction>();
  const activity = useAssistantActivity();
  const [input, setInput] = useState('');

  const isSearching =
    view.stage === 'recommendations' &&
    (!view.discovery || view.discovery.status === 'queued' || view.discovery.status === 'running');

  const showSearchBubble =
    view.stage === 'recommendations' ||
    (view.stage !== 'chat' && messages.length > 0 && messages[0]?.role === 'user' && (!messages[1] || messages[1].role === 'user'));

  // 1. Chronological anchoring so follow-up messages always render BELOW the initial search response
  const {
    isLatestUser,
    shouldRenderAfterMessage,
    shouldRenderStandalone,
  } = useAnchoredActivityBubble(showSearchBubble);

  // 2. Multi-step progression timers (supports 2 to 5 dynamic steps)
  const searchPhase = useStepProgression(isSearching, {
    startPhase: 1,
    completedPhase: 5,
    delaysMs: [450, 1050, 1750],
  });

  const turnPhase = useStepProgression(!!activity.activeTurn, {
    resetKey: activity.activeTurn?.runId,
    startPhase: 0,
    completedPhase: 5,
    delaysMs: [500, 1150, 1850, 2600],
  });

  const initialUserText =
    messages.find(m => m.role === 'user')?.parts.find((p: any) => p.type === 'text')?.text ?? view.intent;
  const latestUserText =
    [...messages].reverse().find(m => m.role === 'user')?.parts.find((p: any) => p.type === 'text')?.text ?? view.intent;

  // 3. Deterministic 2-to-5 step checklists & varied conversational summaries
  const searchSteps = buildVariedSearchSteps({
    goal: view.intent,
    query: initialUserText,
    isSearching,
    activePhaseIndex: searchPhase,
    resourcePlural: 'projects',
  });

  const searchSummary = buildVariedSearchSummary({
    goal: view.intent || initialUserText,
    step: view.stage,
    status: view.discovery?.status,
    matchCount: view.discovery?.items.length ?? 0,
    isSearching,
    createCtaLabel: 'Open studio',
    resourceSingular: 'project',
    resourcePlural: 'projects',
  });

  const turnSteps = buildVariedTurnSteps({
    latestUserText,
    goal: view.intent,
    step: view.stage,
    hasLessons: view.items.length > 0,
    runId: activity.activeTurn?.runId,
    activePhaseIndex: turnPhase,
  });

  const handleSubmit = async (textToSend = input) => {
    const trimmed = textToSend.trim();
    if (!trimmed) return;
    setInput('');

    // 4. Immediate client-side implicit action dispatch ("Tadada~" panel open)
    const implicitAction = detectImplicitWorkspaceAction(trimmed, view.stage);
    if (implicitAction) {
      void dispatchAction(implicitAction);
    }

    await sendMessage(trimmed);
  };

  const renderSearchBubble = () => (
    <div key="search-activity-bubble" role="status" aria-live="polite">
      <InteractionStepTrail steps={searchSteps} ariaLabel="Discovery progress" />
      {searchSummary && <p>{searchSummary}</p>}
    </div>
  );

  const suggestions = getWorkspaceSuggestions(view.stage, { goal: view.intent });
  const showSuggestions = !activity.hasActiveTurn && !isSearching && !isLatestUser;

  return (
    <div>
      <div>
        {messages.map(m => (
          <React.Fragment key={m.id}>
            <div data-role={m.role}>
              {m.parts.map((p: any, idx: number) =>
                p.type === 'text' ? <p key={idx}>{p.text}</p> : null
              )}
            </div>
            {shouldRenderAfterMessage(m.id) && renderSearchBubble()}
          </React.Fragment>
        ))}

        {shouldRenderStandalone && renderSearchBubble()}

        {activity.activeTurn && (
          <div role="status" aria-live="polite">
            <InteractionStepTrail steps={turnSteps} ariaLabel="Assistant turn progress" />
            <button type="button" onClick={() => void activity.cancelActiveTurn()}>
              Stop
            </button>
          </div>
        )}
      </div>

      {showSuggestions && (
        <div role="group" aria-label="Suggested next steps">
          {suggestions.map(s => (
            <button key={s.id} type="button" onClick={() => void handleSubmit(s.prompt)}>
              {s.label}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={e => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask anything or describe what to build..."
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

function StudioCanvas() {
  const view = useWorkspaceView<MyWorkspace>();
  const dispatchAction = useDispatchAction<MyAction>();

  return (
    <section>
      <h1>{view.title}</h1>
      <button type="button" onClick={() => void dispatchAction({ type: 'open_studio' })}>
        Open Studio
      </button>
    </section>
  );
}
```
```

---

## Exported Capabilities Reference (`interaction-builder/core` & `interaction-builder/react`)

| Symbol | Subpath | Purpose |
| :--- | :--- | :--- |
| `<InteractionStepTrail />` | `interaction-builder/react` | Borderless inline vertical timeline checklist with built-in SVG check/spinner/dot markers and optional custom `classNames`. |
| `useStepProgression(isActive, opts)` | `interaction-builder/react` | Advances step phase index across 2–5 steps with configurable millisecond intervals. |
| `useAnchoredActivityBubble(showBubble)` | `interaction-builder/react` | Anchors unpersisted search/discovery activity bubbles right after `messages[0]` so follow-up messages never render above initial search responses. |
| `useAssistantActivity(opts)` | `interaction-builder/react` | ETag-aware assistant run poller with background-tab pause/resume and `cancelActiveTurn()`. |
| `buildVariedSteps(opts)` | `interaction-builder/core` & `/react` | Generic deterministic 2–5 step generator with custom 5-stage pools and `{{topic}}` interpolation. |
| `buildVariedSearchSteps(opts)` | `interaction-builder/core` & `/react` | Topic-aware 2–5 step discovery/search checklist generator. |
| `buildVariedTurnSteps(opts)` | `interaction-builder/core` & `/react` | Intent-aware 2–5 step assistant turn checklist generator (studio launch, search, next-steps guidance, review, sources, general). |
| `buildVariedSearchSummary(opts)` | `interaction-builder/core` & `/react` | Multi-variant markdown summary generator for 0-match, matched, failed, and studio-opened states. |
| `resolveActivityAnchorMessageId(msgs, show)` | `interaction-builder/core` & `/react` | Pure helper computing the message ID after which an unpersisted activity bubble must render. |
| `createImplicitActionDetector(rules)` | `interaction-builder/core` & `/react` | Declarative regex-to-action matcher for immediate optimistic domain actions from chat input. |
| `resolveSplitCanvasLayout(opts)` | `interaction-builder/core` & `/react` | Computes `'centered' \| 'split'` for the delayed "Tadada~" right-panel reveal. |
| `createStageSuggestions(map, max)` | `interaction-builder/core` & `/react` | Stage-aware contextual quick-reply suggestion chip generator. |
