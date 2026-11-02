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
export function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function pickDeterministic<T>(items: readonly T[], seed: number, offset = 0): T {
  const index = Math.abs(seed + offset * 7919) % items.length;
  return items[index];
}

export function formatShortTopic(raw?: string, maxLength = 34): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLength - 3)).trimEnd()}…`;
}

const DEFAULT_STEP_COUNTS = [2, 3, 4, 5, 3, 4, 2, 5] as const;

export function pickStepCount(
  seed: number,
  allowedCounts: readonly (2 | 3 | 4 | 5)[] = DEFAULT_STEP_COUNTS
): 2 | 3 | 4 | 5 {
  const list = allowedCounts.length > 0 ? allowedCounts : DEFAULT_STEP_COUNTS;
  return list[seed % list.length];
}

function interpolateTopic(template: string, topic: string | null, fallbackTopic = 'your request'): string {
  return template.replace(/\{\{topic\}\}/g, topic || fallbackTopic);
}

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

const DEFAULT_GENERAL_POOLS: FiveStagePools = {
  stage1: [
    'Processing your query',
    'Reading your message',
    'Tuning in to your question',
    'Unpacking your thought',
  ],
  stage2: [
    'Mapping concepts around {{topic}}',
    'Exploring foundational mental models',
    'Structuring a clear pathway',
    'Identifying high-impact focus areas',
  ],
  stage3: [
    'Connecting context to practical actions',
    'Sequencing milestones from the ground up',
    'Curating relevant angles & examples',
  ],
  stage4: [
    'Tailoring depth & structure',
    'Calibrating recommendations to your goal',
    'Sharpening key takeaways',
  ],
  stage5: [
    'Drafting tailored response',
    'Putting together your action plan',
    'Weaving everything into a clear reply',
  ],
};

/**
 * Generic variable-length (2–5 steps) deterministic step builder usable by any domain/site.
 */
export function buildVariedSteps({
  seedKey,
  topic,
  isActive,
  activePhaseIndex,
  minRunningIndex = 0,
  idPrefix = 'ib-step',
  pools = DEFAULT_GENERAL_POOLS,
  allowedCounts,
}: BuildVariedStepsOptions): InteractionProgressStep[] {
  const shortTopic = formatShortTopic(topic);
  const seed = hashSeed(seedKey);
  const count = pickStepCount(seed, allowedCounts);

  const stageArray = [
    pools.stage1,
    pools.stage2,
    pools.stage3,
    pools.stage4,
    pools.stage5,
  ];

  let selectedPoolIndices: number[];
  if (count === 2) {
    selectedPoolIndices = [0, 4];
  } else if (count === 3) {
    selectedPoolIndices = [0, 1, 4];
  } else if (count === 4) {
    selectedPoolIndices = [0, 1, 2, 4];
  } else {
    selectedPoolIndices = [0, 1, 2, 3, 4];
  }

  const runningIdx = Math.min(
    Math.max(minRunningIndex, activePhaseIndex),
    selectedPoolIndices.length - 1
  );

  return selectedPoolIndices.map((poolIdx, idx) => {
    const rawTemplate = pickDeterministic(stageArray[poolIdx], seed, idx + 1);
    const label = interpolateTopic(rawTemplate, shortTopic, 'your goal');
    if (!isActive) {
      return { id: `${idPrefix}-${idx}`, label, state: 'complete' };
    }
    const state: InteractionProgressStep['state'] =
      idx < runningIdx ? 'complete' : idx === runningIdx ? 'running' : 'pending';
    return {
      id: `${idPrefix}-${idx}`,
      label,
      state,
    };
  });
}

export interface VariedSearchStepsOptions {
  goal?: string;
  query?: string;
  intentVersion?: number;
  isSearching: boolean;
  activePhaseIndex: number;
  /** Optional noun for what is being searched (default: `'cohorts'`, e.g. `'templates'`, `'projects'`, `'workflows'`) */
  resourcePlural?: string;
}

export function buildVariedSearchSteps({
  goal,
  query,
  intentVersion = 0,
  isSearching,
  activePhaseIndex,
  resourcePlural = 'cohorts',
}: VariedSearchStepsOptions): InteractionProgressStep[] {
  const rawTopic = query?.trim() || goal?.trim() || '';
  const shortTopic = formatShortTopic(rawTopic);
  const seed = hashSeed(`search::${rawTopic.toLowerCase()}::${intentVersion}::${resourcePlural}`);
  const count = pickStepCount(seed);

  const stage1Pool = shortTopic
    ? [
        `Reading your prompt on ${shortTopic}`,
        `Unpacking "${shortTopic}"`,
        `Parsing your interest in ${shortTopic}`,
        `Tuning in to ${shortTopic}`,
        `Capturing your learning focus`,
        `Processing your query`,
      ]
    : [
        'Processing your query',
        'Reading your learning prompt',
        'Unpacking what you want to explore',
        'Capturing your curiosity',
        'Parsing your topic focus',
      ];

  const stage2Pool = shortTopic
    ? [
        `Mapping key concepts in ${shortTopic}`,
        `Understanding your learning goal`,
        `Identifying core pillars for ${shortTopic}`,
        `Scoping skill depth & prerequisites`,
        `Framing a study trajectory for ${shortTopic}`,
        `Distilling key themes & milestones`,
      ]
    : [
        'Understanding your learning goal',
        'Mapping core concepts & skill depth',
        'Identifying foundational pillars',
        'Scoping a practical learning arc',
        'Distilling key study themes',
      ];

  const stage3Pool = shortTopic
    ? [
        `Scanning live ${resourcePlural} for ${shortTopic}`,
        `Searching community ${resourcePlural} for matches`,
        `Looking for active ${shortTopic} study groups`,
        `Checking ongoing peer ${resourcePlural} & syllabi`,
        `Exploring public ${resourcePlural} in this space`,
      ]
    : [
        `Searching ${resourcePlural} for you`,
        `Scanning active community ${resourcePlural}`,
        `Looking for matching study groups`,
        `Checking live peer ${resourcePlural} & syllabi`,
        `Exploring public learning ${resourcePlural}`,
      ];

  const stage4Pool = [
    'Comparing curriculum depth & pacing',
    'Filtering by topic relevance & structure',
    `Ranking the closest ${resourcePlural.replace(/s$/, '')} matches`,
    'Checking studio templates & starting paths',
    'Weighing peer group fit & study rhythm',
  ];

  const stage5Pool = [
    'Preparing your workspace canvas',
    'Lining up recommendations & studio tools',
    'Setting up your studio view',
    'Finalizing matches & next steps',
    'Opening your tailored workspace',
  ];

  let selectedLabels: string[];
  if (count === 2) {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage3Pool, seed, 2),
    ];
  } else if (count === 3) {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage2Pool, seed, 2),
      pickDeterministic(stage3Pool, seed, 3),
    ];
  } else if (count === 4) {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage2Pool, seed, 2),
      pickDeterministic(stage3Pool, seed, 3),
      pickDeterministic(stage5Pool, seed, 4),
    ];
  } else {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage2Pool, seed, 2),
      pickDeterministic(stage3Pool, seed, 3),
      pickDeterministic(stage4Pool, seed, 4),
      pickDeterministic(stage5Pool, seed, 5),
    ];
  }

  const runningIdx = Math.min(Math.max(1, activePhaseIndex), selectedLabels.length - 1);

  return selectedLabels.map((label, idx) => {
    if (!isSearching) {
      return { id: `search-step-${idx}`, label, state: 'complete' };
    }
    const state: InteractionProgressStep['state'] =
      idx < runningIdx ? 'complete' : idx === runningIdx ? 'running' : 'pending';
    return {
      id: `search-step-${idx}`,
      label,
      state,
    };
  });
}

export interface VariedTurnStepsOptions {
  latestUserText: string;
  goal?: string;
  step?: string;
  hasLessons?: boolean;
  runId?: string | null;
  activePhaseIndex: number;
}

export function buildVariedTurnSteps({
  latestUserText,
  goal,
  step,
  hasLessons = false,
  runId,
  activePhaseIndex,
}: VariedTurnStepsOptions): InteractionProgressStep[] {
  const trimmed = latestUserText.trim();
  const shortTopic = formatShortTopic(goal || trimmed);
  const seed = hashSeed(`turn::${trimmed.toLowerCase()}::${step ?? ''}::${runId ?? ''}`);
  const count = pickStepCount(seed);

  const isCohortStart = /\b(?:start|create|build|make|launch)\b.*\b(?:cohort|course|curriculum|studio|workspace|project)\b|\bcreate\s+my\s+own\b/i.test(trimmed);
  const isCohortSearch = /\b(?:search|find|look\s+for|similar|browse)\b.*\b(?:cohorts?|courses?|projects?|templates?)\b/i.test(trimmed);
  const isNextStepsQuery = /\b(?:what\s+should\s+i\s+do|where\s+do\s+i\s+start|how\s+do\s+i\s+start|what\s+now|next\s+step|help\s+me\s+start)\b/i.test(trimmed);

  let pool: string[][];

  if (isCohortStart) {
    pool = [
      ['Reading your studio request', 'Noting your cohort preferences', 'Locking in your cohort direction'],
      ['Preparing cohort creation studio', 'Configuring your curriculum workspace', 'Spinning up the studio canvas'],
      ['Structuring starting options', 'Setting up material & goal pathways', 'Aligning study pacing defaults'],
      ['Opening cohort studio', 'Launching your builder workspace', 'Handing off to the studio canvas'],
      ['Drafting your kickoff guide', 'Putting together initial suggestions', 'Ready to build together'],
    ];
  } else if (isCohortSearch) {
    pool = [
      ['Reading your search refinement', 'Parsing your updated criteria', 'Checking your topic filters'],
      ['Understanding your learning goal', 'Mapping related subject areas', 'Scoping target skill level'],
      ['Looking for similar cohorts', 'Scanning community study groups', 'Searching public cohort directory'],
      ['Comparing cohort syllabi & pacing', 'Filtering closest topic matches', 'Weighing curriculum overlap'],
      ['Summarizing cohort options', 'Preparing recommendations', 'Wrapping up search insights'],
    ];
  } else if (isNextStepsQuery) {
    pool = [
      ['Checking where we are in your studio', 'Reading your question', 'Reviewing your current workspace state'],
      [
        shortTopic ? `Looking at your ${shortTopic} goal` : 'Reviewing your learning goal',
        'Evaluating the best starting angle',
        'Mapping practical first milestones',
      ],
      ['Sketching a clear action plan', 'Weighing self-paced vs. source-led paths', 'Organizing concrete next steps'],
      ['Tailoring recommendations to your pace', 'Picking the highest-leverage first move', 'Structuring a week-by-week preview'],
      ['Drafting your next-steps guide', 'Putting together clear options', 'Polishing your roadmap advice'],
    ];
  } else if (step === 'review' || step === 'ready' || hasLessons) {
    pool = [
      ['Reading your curriculum feedback', 'Parsing your adjustment request', 'Checking your lesson notes'],
      ['Reviewing your curriculum structure', 'Inspecting current questline modules', 'Scanning lesson objectives & flow'],
      ['Evaluating pacing & topic sequence', 'Aligning module depth with your goal', 'Checking prerequisite transitions'],
      ['Refining lesson breakdown', 'Updating syllabus recommendations', 'Polishing module takeaways'],
      ['Drafting tailored response', 'Summarizing curriculum updates', 'Preparing your updated plan'],
    ];
  } else if (step === 'material_input' || step === 'discovery') {
    pool = [
      ['Reading your source notes', 'Parsing your material preferences', 'Capturing your reference criteria'],
      ['Analyzing your learning sources', 'Scanning source coverage & depth', 'Extracting core concepts from materials'],
      ['Connecting sources to your study goal', 'Mapping readings to practical milestones', 'Identifying high-signal sections'],
      ['Structuring source-backed takeaways', 'Organizing reference highlights', 'Weighing source difficulty'],
      ['Drafting tailored response', 'Synthesizing source insights', 'Preparing your study breakdown'],
    ];
  } else {
    pool = [
      ['Processing your query', 'Reading your message', 'Tuning in to your question', 'Unpacking your thought'],
      [
        shortTopic ? `Mapping concepts around ${shortTopic}` : 'Mapping your learning pathway',
        'Exploring foundational mental models',
        'Structuring a clear learning arc',
        'Identifying high-impact subtopics',
      ],
      ['Connecting theory to hands-on practice', 'Sequencing milestones from basics up', 'Curating practical study angles'],
      ['Tailoring depth & weekly rhythm', 'Calibrating examples to your goal', 'Sharpening key takeaways'],
      ['Drafting tailored response', 'Putting together your learning plan', 'Weaving everything into a clear reply'],
    ];
  }

  let stageIndices: number[];
  if (count === 2) {
    stageIndices = [0, 4];
  } else if (count === 3) {
    stageIndices = [0, 1, 4];
  } else if (count === 4) {
    stageIndices = [0, 1, 2, 4];
  } else {
    stageIndices = [0, 1, 2, 3, 4];
  }

  const runningIdx = Math.min(Math.max(0, activePhaseIndex), stageIndices.length - 1);

  return stageIndices.map((poolIdx, idx) => {
    const label = pickDeterministic(pool[poolIdx], seed, idx + 1);
    const state: InteractionProgressStep['state'] =
      idx < runningIdx ? 'complete' : idx === runningIdx ? 'running' : 'pending';
    return {
      id: `turn-step-${idx}`,
      label,
      state,
    };
  });
}

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

export function buildVariedSearchSummary({
  goal,
  step,
  status,
  matchCount,
  intentVersion = 0,
  isSearching,
  createCtaLabel = 'Create your own cohort',
  resourceSingular = 'cohort',
  resourcePlural = 'cohorts',
}: VariedSearchSummaryOptions): string | null {
  if (isSearching) return null;
  const topicLabel = goal?.trim() || 'your learning goal';
  const seed = hashSeed(`summary::${topicLabel.toLowerCase()}::${step ?? ''}::${status ?? ''}::${matchCount}::${intentVersion}`);

  if (step === 'recommendations') {
    if (status === 'failed') {
      const failedTemplates = [
        `I hit a snag while checking public ${resourcePlural} for **${topicLabel}**. I’ve opened the studio panel on the right so you can retry the search or jump straight into **${createCtaLabel}**.`,
        `I couldn’t finish searching public ${resourcePlural} for **${topicLabel}** just now. You can retry from the right-hand panel or click **${createCtaLabel}** to start building right away.`,
        `Our ${resourceSingular} directory didn’t respond in time for **${topicLabel}**, so I’ve opened the studio on the right — feel free to retry the search or spin up your own custom ${resourceSingular}!`,
        `Something interrupted the ${resourceSingular} lookup for **${topicLabel}**. No worries — the workspace on the right is open so you can retry or click **${createCtaLabel}** to design your own plan.`,
      ];
      return pickDeterministic(failedTemplates, seed);
    }

    if (matchCount > 0) {
      const noun = matchCount === 1 ? resourceSingular : resourcePlural;
      const pron = matchCount === 1 ? 'it' : 'them';
      const matchTemplates = [
        `I found **${matchCount}** matching community ${noun} for **${topicLabel}** and lined ${pron} up on the right. Browse the matches to join one, or click **${createCtaLabel}** to craft a custom syllabus.`,
        `Good news — there ${matchCount === 1 ? 'is' : 'are'} **${matchCount}** active community ${noun} around **${topicLabel}**! Check ${pron} out in the right panel, or hit **${createCtaLabel}** if you want a tailored plan.`,
        `I’ve pulled up **${matchCount}** public ${noun} related to **${topicLabel}** on the right. You can hop into an existing group or click **${createCtaLabel}** to build from scratch.`,
        `We spotted **${matchCount}** community ${noun} exploring **${topicLabel}**! Take a look on the right to see if the pacing fits, or choose **${createCtaLabel}** to design your own journey.`,
        `I scanned our directory for **${topicLabel}** and found **${matchCount}** matching ${noun} (now open on the right). Join a group that resonates, or start fresh with **${createCtaLabel}**.`,
        `There ${matchCount === 1 ? 'is' : 'are'} **${matchCount}** peer ${noun} for **${topicLabel}** ready to explore on the right. Feel free to join ${pron}, or tell me here how you’d like to customize your own ${resourceSingular}!`,
      ];
      return pickDeterministic(matchTemplates, seed);
    }

    const zeroMatchTemplates = [
      `I searched our public ${resourcePlural} for **${topicLabel}**, and no matching community ${resourcePlural} exist yet. I’ve opened the studio on the right — click **${createCtaLabel}** (or tell me here how you’d like to start) to launch the first one!`,
      `No one has launched a public ${resourceSingular} for **${topicLabel}** yet — which means you get to pioneer it! Use **${createCtaLabel}** on the right, or tell me your goals here and we’ll sketch the syllabus together.`,
      `I checked our active directory for **${topicLabel}** and came up empty on existing groups. I’ve popped open the builder on the right so you can click **${createCtaLabel}** and shape a custom study plan.`,
      `It looks like **${topicLabel}** is fresh territory in our community ${resourcePlural}! Head over to the panel on the right and hit **${createCtaLabel}**, or reply here with what you want to cover first.`,
      `We don’t have a live community ${resourceSingular} for **${topicLabel}** right now, so I’ve set up the studio on the right for you. Click **${createCtaLabel}** to kick one off — or ask me to draft a learning roadmap here!`,
      `Zero public ${resourcePlural} matched **${topicLabel}** so far. Let’s build one tailored to you: click **${createCtaLabel}** on the right canvas, or share your background here to get started.`,
      `I scanned our community ${resourcePlural} for **${topicLabel}**, and none are running yet. You can be the first — click **${createCtaLabel}** on the right or tell me what materials and goals you have in mind!`,
      `No active ${resourcePlural} matched **${topicLabel}** today, so I opened the studio canvas on the right. Hit **${createCtaLabel}** to design your own track, or chat with me here to brainstorm modules!`,
    ];
    return pickDeterministic(zeroMatchTemplates, seed);
  }

  const studioOpenedTemplates = [
    `I’ve opened the ${resourceSingular} studio on the right for **${topicLabel}**. Choose your starting point on the canvas or tell me what materials and goals you have in mind!`,
    `Your ${resourceSingular} studio for **${topicLabel}** is live on the right! Pick a starting path on the canvas, or tell me here how you’d like to structure your learning.`,
    `We checked existing ${resourcePlural} for **${topicLabel}** and opened your builder workspace on the right. Select how you want to begin on the canvas, or chat with me here to shape your plan!`,
    `I’ve set up the studio canvas on the right for **${topicLabel}**. You can bring your own sources, let us find materials, or ask me here to sketch an initial roadmap.`,
    `Ready to build your **${topicLabel}** ${resourceSingular}! Use the studio controls on the right to pick your starting point, or tell me about your background and timeline right here.`,
  ];
  return pickDeterministic(studioOpenedTemplates, seed);
}

/**
 * Checks whether `messages[0]` is an initial user intake prompt that has no persisted
 * assistant reply row at `messages[1]` (e.g. search/discovery intake mode).
 */
export function hasUnansweredInitialUserPrompt(
  messages: ReadonlyArray<{ id: string; role: string }>
): boolean {
  return (
    messages.length > 0 &&
    messages[0]?.role === 'user' &&
    (!messages[1] || messages[1].role === 'user')
  );
}

/**
 * Resolves the exact message ID after which an unpersisted search/activity bubble
 * should be anchored so follow-up messages and assistant replies always render
 * below it in true chronological order.
 */
export function resolveActivityAnchorMessageId(
  messages: ReadonlyArray<{ id: string; role: string }>,
  showActivityBubble: boolean
): string | null {
  if (!showActivityBubble || messages.length === 0) return null;
  if (hasUnansweredInitialUserPrompt(messages)) {
    return messages[0].id;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      return messages[i].id;
    }
  }
  return messages[messages.length - 1].id;
}

/**
 * Determines whether the anchored activity bubble sits at the very end of the conversation
 * (so next-step suggestions can be displayed once the activity finishes).
 */
export function isAnchoredBubbleAtConversationEnd(
  messages: ReadonlyArray<{ id: string; role: string }>,
  showActivityBubble: boolean,
  anchorMessageId: string | null
): boolean {
  if (!showActivityBubble) return false;
  const latest = messages[messages.length - 1];
  return !anchorMessageId || latest?.id === anchorMessageId;
}

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
export function createImplicitActionDetector<Action, Stage = string>(
  rules: readonly ImplicitActionRule<Action, Stage>[]
): (text: string, currentStage?: Stage) => Action | null {
  return (text: string, currentStage?: Stage): Action | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;

    for (const rule of rules) {
      if (rule.allowedStages && rule.allowedStages.length > 0) {
        if (currentStage === undefined || !rule.allowedStages.includes(currentStage)) {
          continue;
        }
      }
      if ((rule.ignoreQuestions ?? true) && trimmed.endsWith('?')) {
        continue;
      }
      for (const pattern of rule.patterns) {
        if (pattern.test(trimmed)) {
          return typeof rule.action === 'function'
            ? (rule.action as (matchText: string) => Action)(trimmed)
            : rule.action;
        }
      }
    }
    return null;
  };
}

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
export function resolveSplitCanvasLayout({
  stage,
  centeredStages = ['chat'],
  discoveryStage = 'recommendations',
  discoveryStatus,
}: SplitCanvasLayoutOptions): 'centered' | 'split' {
  if (!stage) return 'split';
  if (centeredStages.includes(stage)) return 'centered';
  if (
    stage === discoveryStage &&
    (!discoveryStatus || discoveryStatus === 'queued' || discoveryStatus === 'running')
  ) {
    return 'centered';
  }
  return 'split';
}

export interface InteractionSuggestion {
  id: string;
  label: string;
  prompt: string;
}

export type StageSuggestionMap<Stage extends string, Context = Record<string, unknown>> = {
  [K in Stage]?:
    | readonly InteractionSuggestion[]
    | ((ctx: Context) => readonly InteractionSuggestion[]);
} & {
  default?:
    | readonly InteractionSuggestion[]
    | ((ctx: Context) => readonly InteractionSuggestion[]);
};

/**
 * Creates a reusable stage-aware suggestion chip resolver for any conversational workspace.
 */
export function createStageSuggestions<Stage extends string, Context = Record<string, unknown>>(
  map: StageSuggestionMap<Stage, Context>,
  maxSuggestions = 3
): (stage: Stage | undefined, ctx: Context) => InteractionSuggestion[] {
  return (stage: Stage | undefined, ctx: Context): InteractionSuggestion[] => {
    const entry = (stage ? map[stage] : undefined) ?? map.default;
    if (!entry) return [];
    const list: readonly InteractionSuggestion[] =
      typeof entry === 'function'
        ? (entry as (c: Context) => readonly InteractionSuggestion[])(ctx)
        : (entry as readonly InteractionSuggestion[]);
    return list.slice(0, maxSuggestions);
  };
}
