// src/core/contracts.ts
import { z } from "zod";
var PROTOCOL_VERSION = 1;
var PACKAGE_VERSION = "0.1.0";
function isSupportedProtocolVersion(version) {
  return version === PROTOCOL_VERSION;
}
var entityRefSchema = z.strictObject({
  kind: z.string().min(1).max(80),
  id: z.string().min(1).max(200),
  version: z.number().int().nonnegative()
});
var changeReceiptSchema = z.strictObject({
  receiptId: z.string().uuid(),
  actionId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
  changed: z.array(entityRefSchema).max(100),
  undoable: z.boolean()
});
var messagePartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().max(32e3) }),
  z.strictObject({ type: z.literal("entity_ref"), entity: entityRefSchema, label: z.string().max(300) }),
  z.strictObject({ type: z.literal("activity"), status: z.enum(["queued", "running", "waiting", "done", "failed"]), text: z.string().max(500) }),
  z.strictObject({ type: z.literal("change_receipt"), receipt: changeReceiptSchema }),
  z.strictObject({ type: z.literal("warning"), text: z.string().max(2e3) })
]);
var interactionMessageSchema = z.strictObject({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(messagePartSchema).min(1).max(100),
  sequence: z.number().int().positive(),
  runId: z.string().uuid().nullable()
});
var interactionEventSchema = z.strictObject({
  protocolVersion: z.literal(1),
  eventId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: z.enum([
    "message.accepted",
    "message.updated",
    "workspace.committed",
    "run.changed",
    "job.changed",
    "proposal.created",
    "proposal.resolved"
  ]),
  revision: z.number().int().nonnegative().optional(),
  payload: z.unknown()
});
var actionEnvelopeSchema = z.strictObject({
  actionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  entityVersions: z.array(entityRefSchema).max(100),
  action: z.unknown()
});
function defineAction(type, schema) {
  return {
    type,
    schema,
    create(payload) {
      if (schema) {
        schema.parse(payload);
      }
      return { type, ...payload };
    }
  };
}
var hostCommandEnvelopeSchema = z.strictObject({
  commandId: z.string().uuid(),
  ownerId: z.string().min(1).max(200),
  resourceId: z.string().min(1).max(200),
  expectedVersion: z.number().int().nonnegative(),
  readSet: z.array(entityRefSchema).max(100).optional(),
  command: z.unknown()
});
var hostCommandReceiptSchema = z.strictObject({
  receiptId: z.string().uuid(),
  commandId: z.string().uuid(),
  resourceId: z.string().min(1).max(200),
  resultingVersion: z.number().int().nonnegative(),
  summary: z.string().min(1).max(500),
  changed: z.array(entityRefSchema).max(100),
  committedAt: z.string()
});
var hostResourceBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  resourceId: z.string().min(1).max(200),
  resourceKind: z.string().min(1).max(80),
  observedVersion: z.number().int().nonnegative(),
  selectedEntityId: z.string().nullable().optional()
});

// src/core/patch.ts
function escapeJsonPointer(str) {
  return str.replace(/~/g, "~0").replace(/\//g, "~1");
}
function unescapeJsonPointer(str) {
  return str.replace(/~1/g, "/").replace(/~0/g, "~");
}
function parsePointer(path) {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error(`Invalid JSON Pointer: "${path}"`);
  return path.slice(1).split("/").map(unescapeJsonPointer);
}
function applyJsonPatch(doc, patch) {
  let root = structuredClone(doc);
  for (const op of patch) {
    const tokens = parsePointer(op.path);
    if (tokens.length === 0) {
      if (op.op === "replace" || op.op === "add") {
        root = structuredClone(op.value);
        continue;
      }
      throw new Error(`Cannot perform op "${op.op}" on document root`);
    }
    let parent = root;
    for (let i = 0; i < tokens.length - 1; i++) {
      const key = tokens[i];
      if (parent === null || typeof parent !== "object") {
        throw new Error(`Cannot traverse path "${op.path}"`);
      }
      parent = parent[key];
    }
    const lastKey = tokens[tokens.length - 1];
    if (op.op === "add") {
      if (Array.isArray(parent)) {
        const index = lastKey === "-" ? parent.length : Number(lastKey);
        if (!Number.isInteger(index) || index < 0 || index > parent.length) {
          throw new Error(`Invalid array index "${lastKey}" for add`);
        }
        parent.splice(index, 0, structuredClone(op.value));
      } else if (parent && typeof parent === "object") {
        parent[lastKey] = structuredClone(op.value);
      } else {
        throw new Error(`Cannot add to non-object parent at "${op.path}"`);
      }
    } else if (op.op === "replace") {
      if (Array.isArray(parent)) {
        const index = Number(lastKey);
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
          throw new Error(`Invalid array index "${lastKey}" for replace`);
        }
        parent[index] = structuredClone(op.value);
      } else if (parent && typeof parent === "object") {
        if (!(lastKey in parent)) throw new Error(`Property "${lastKey}" not found for replace`);
        parent[lastKey] = structuredClone(op.value);
      }
    } else if (op.op === "remove") {
      if (Array.isArray(parent)) {
        const index = Number(lastKey);
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
          throw new Error(`Invalid array index "${lastKey}" for remove`);
        }
        parent.splice(index, 1);
      } else if (parent && typeof parent === "object") {
        if (!(lastKey in parent)) throw new Error(`Property "${lastKey}" not found for remove`);
        delete parent[lastKey];
      }
    } else if (op.op === "test") {
      const actual = parent?.[lastKey];
      if (JSON.stringify(actual) !== JSON.stringify(op.value)) {
        throw new Error(`Test operation failed at "${op.path}"`);
      }
    } else {
      throw new Error(`Unsupported JSON Patch operation: "${op.op}"`);
    }
  }
  return root;
}
function generateJsonPatch(prev, next, basePath = "") {
  const patch = [];
  if (prev === next) return patch;
  if (prev === null || next === null || typeof prev !== "object" || typeof next !== "object" || Array.isArray(prev) !== Array.isArray(next)) {
    patch.push({ op: "replace", path: basePath, value: next });
    return patch;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length === next.length) {
      for (let i = 0; i < prev.length; i++) {
        const itemPath = `${basePath}/${i}`;
        patch.push(...generateJsonPatch(prev[i], next[i], itemPath));
      }
    } else {
      patch.push({ op: "replace", path: basePath, value: next });
    }
    return patch;
  }
  const prevObj = prev;
  const nextObj = next;
  const prevKeys = Object.keys(prevObj);
  const nextKeys = Object.keys(nextObj);
  for (const k of prevKeys) {
    if (!(k in nextObj)) {
      patch.push({ op: "remove", path: `${basePath}/${escapeJsonPointer(k)}` });
    }
  }
  for (const k of nextKeys) {
    const keyPath = `${basePath}/${escapeJsonPointer(k)}`;
    if (!(k in prevObj)) {
      patch.push({ op: "add", path: keyPath, value: nextObj[k] });
    } else {
      patch.push(...generateJsonPatch(prevObj[k], nextObj[k], keyPath));
    }
  }
  return patch;
}
function getValueByPointer(doc, path) {
  if (path === "") return doc;
  const tokens = parsePointer(path);
  let current = doc;
  for (const token of tokens) {
    if (current === null || typeof current !== "object") return void 0;
    if (!(token in current)) return void 0;
    current = current[token];
  }
  return current;
}
function invertJsonPatch(doc, patch) {
  const inverted = [];
  for (let i = patch.length - 1; i >= 0; i--) {
    const op = patch[i];
    if (op.path === "") {
      inverted.push({ op: "replace", path: "", value: structuredClone(doc) });
      continue;
    }
    if (op.op === "add") {
      inverted.push({ op: "remove", path: op.path });
    } else if (op.op === "remove") {
      const prevVal = getValueByPointer(doc, op.path);
      inverted.push({ op: "add", path: op.path, value: structuredClone(prevVal) });
    } else if (op.op === "replace") {
      const prevVal = getValueByPointer(doc, op.path);
      inverted.push({ op: "replace", path: op.path, value: structuredClone(prevVal) });
    } else {
      throw new Error(`Unsupported JSON Patch operation for inversion: "${op.op}"`);
    }
  }
  return inverted;
}

// src/core/reducer.ts
function reduceInteraction(state, input) {
  if (input.kind === "snapshot") {
    if (input.workspaceId !== state.workspaceId) return state;
    return {
      ...state,
      revision: input.revision,
      sequence: input.sequence,
      view: input.view,
      messages: input.messages,
      connection: "live"
    };
  }
  if (input.kind === "request_pending") {
    return { ...state, pending: { ...state.pending, [input.actionId]: "pending" } };
  }
  if (input.kind === "request_failed") {
    const pending = { ...state.pending, [input.actionId]: "failed" };
    return { ...state, pending };
  }
  if (input.kind === "connection") {
    return { ...state, connection: input.value };
  }
  const parsed = interactionEventSchema.safeParse(input.event);
  if (!parsed.success || parsed.data.workspaceId !== state.workspaceId) return state;
  const event = parsed.data;
  if (event.sequence <= state.sequence) return state;
  if (event.sequence !== state.sequence + 1) {
    return { ...state, connection: "reset_required" };
  }
  if (event.type === "message.accepted" && event.payload?.message) {
    const msg = event.payload.message;
    const messages = state.messages.some((m) => m.id === msg.id) ? state.messages : [...state.messages, msg];
    return { ...state, sequence: event.sequence, messages };
  }
  if (event.type === "workspace.committed" && event.revision !== void 0) {
    const payload = event.payload;
    if (payload?.patch && state.view) {
      try {
        const nextView = applyJsonPatch(state.view, payload.patch);
        return { ...state, sequence: event.sequence, revision: event.revision, view: nextView };
      } catch {
      }
    }
    if (payload?.snapshot !== void 0) {
      return { ...state, sequence: event.sequence, revision: event.revision, view: payload.snapshot };
    }
    return { ...state, sequence: event.sequence, revision: event.revision };
  }
  return { ...state, sequence: event.sequence };
}

// src/core/progress-ux.ts
function hashSeed(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function pickDeterministic(items, seed, offset = 0) {
  const index = Math.abs(seed + offset * 7919) % items.length;
  return items[index];
}
function formatShortTopic(raw, maxLength = 34) {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLength - 3)).trimEnd()}\u2026`;
}
var DEFAULT_STEP_COUNTS = [2, 3, 4, 5, 3, 4, 2, 5];
function pickStepCount(seed, allowedCounts = DEFAULT_STEP_COUNTS) {
  const list = allowedCounts.length > 0 ? allowedCounts : DEFAULT_STEP_COUNTS;
  return list[seed % list.length];
}
function interpolateTopic(template, topic, fallbackTopic = "your request") {
  return template.replace(/\{\{topic\}\}/g, topic || fallbackTopic);
}
var DEFAULT_GENERAL_POOLS = {
  stage1: [
    "Processing your query",
    "Reading your message",
    "Tuning in to your question",
    "Unpacking your thought"
  ],
  stage2: [
    "Mapping concepts around {{topic}}",
    "Exploring foundational mental models",
    "Structuring a clear pathway",
    "Identifying high-impact focus areas"
  ],
  stage3: [
    "Connecting context to practical actions",
    "Sequencing milestones from the ground up",
    "Curating relevant angles & examples"
  ],
  stage4: [
    "Tailoring depth & structure",
    "Calibrating recommendations to your goal",
    "Sharpening key takeaways"
  ],
  stage5: [
    "Drafting tailored response",
    "Putting together your action plan",
    "Weaving everything into a clear reply"
  ]
};
function buildVariedSteps({
  seedKey,
  topic,
  isActive,
  activePhaseIndex,
  minRunningIndex = 0,
  idPrefix = "ib-step",
  pools = DEFAULT_GENERAL_POOLS,
  allowedCounts
}) {
  const shortTopic = formatShortTopic(topic);
  const seed = hashSeed(seedKey);
  const count = pickStepCount(seed, allowedCounts);
  const stageArray = [
    pools.stage1,
    pools.stage2,
    pools.stage3,
    pools.stage4,
    pools.stage5
  ];
  let selectedPoolIndices;
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
    const label = interpolateTopic(rawTemplate, shortTopic, "your goal");
    if (!isActive) {
      return { id: `${idPrefix}-${idx}`, label, state: "complete" };
    }
    const state = idx < runningIdx ? "complete" : idx === runningIdx ? "running" : "pending";
    return {
      id: `${idPrefix}-${idx}`,
      label,
      state
    };
  });
}
function buildVariedSearchSteps({
  goal,
  query,
  intentVersion = 0,
  isSearching,
  activePhaseIndex,
  resourcePlural = "cohorts"
}) {
  const rawTopic = query?.trim() || goal?.trim() || "";
  const shortTopic = formatShortTopic(rawTopic);
  const seed = hashSeed(`search::${rawTopic.toLowerCase()}::${intentVersion}::${resourcePlural}`);
  const count = pickStepCount(seed);
  const stage1Pool = shortTopic ? [
    `Reading your prompt on ${shortTopic}`,
    `Unpacking "${shortTopic}"`,
    `Parsing your interest in ${shortTopic}`,
    `Tuning in to ${shortTopic}`,
    `Capturing your learning focus`,
    `Processing your query`
  ] : [
    "Processing your query",
    "Reading your learning prompt",
    "Unpacking what you want to explore",
    "Capturing your curiosity",
    "Parsing your topic focus"
  ];
  const stage2Pool = shortTopic ? [
    `Mapping key concepts in ${shortTopic}`,
    `Understanding your learning goal`,
    `Identifying core pillars for ${shortTopic}`,
    `Scoping skill depth & prerequisites`,
    `Framing a study trajectory for ${shortTopic}`,
    `Distilling key themes & milestones`
  ] : [
    "Understanding your learning goal",
    "Mapping core concepts & skill depth",
    "Identifying foundational pillars",
    "Scoping a practical learning arc",
    "Distilling key study themes"
  ];
  const stage3Pool = shortTopic ? [
    `Scanning live ${resourcePlural} for ${shortTopic}`,
    `Searching community ${resourcePlural} for matches`,
    `Looking for active ${shortTopic} study groups`,
    `Checking ongoing peer ${resourcePlural} & syllabi`,
    `Exploring public ${resourcePlural} in this space`
  ] : [
    `Searching ${resourcePlural} for you`,
    `Scanning active community ${resourcePlural}`,
    `Looking for matching study groups`,
    `Checking live peer ${resourcePlural} & syllabi`,
    `Exploring public learning ${resourcePlural}`
  ];
  const stage4Pool = [
    "Comparing curriculum depth & pacing",
    "Filtering by topic relevance & structure",
    `Ranking the closest ${resourcePlural.replace(/s$/, "")} matches`,
    "Checking studio templates & starting paths",
    "Weighing peer group fit & study rhythm"
  ];
  const stage5Pool = [
    "Preparing your workspace canvas",
    "Lining up recommendations & studio tools",
    "Setting up your studio view",
    "Finalizing matches & next steps",
    "Opening your tailored workspace"
  ];
  let selectedLabels;
  if (count === 2) {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage3Pool, seed, 2)
    ];
  } else if (count === 3) {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage2Pool, seed, 2),
      pickDeterministic(stage3Pool, seed, 3)
    ];
  } else if (count === 4) {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage2Pool, seed, 2),
      pickDeterministic(stage3Pool, seed, 3),
      pickDeterministic(stage5Pool, seed, 4)
    ];
  } else {
    selectedLabels = [
      pickDeterministic(stage1Pool, seed, 1),
      pickDeterministic(stage2Pool, seed, 2),
      pickDeterministic(stage3Pool, seed, 3),
      pickDeterministic(stage4Pool, seed, 4),
      pickDeterministic(stage5Pool, seed, 5)
    ];
  }
  const runningIdx = Math.min(Math.max(1, activePhaseIndex), selectedLabels.length - 1);
  return selectedLabels.map((label, idx) => {
    if (!isSearching) {
      return { id: `search-step-${idx}`, label, state: "complete" };
    }
    const state = idx < runningIdx ? "complete" : idx === runningIdx ? "running" : "pending";
    return {
      id: `search-step-${idx}`,
      label,
      state
    };
  });
}
function buildVariedTurnSteps({
  latestUserText,
  goal,
  step,
  hasLessons = false,
  runId,
  activePhaseIndex
}) {
  const trimmed = latestUserText.trim();
  const shortTopic = formatShortTopic(goal || trimmed);
  const seed = hashSeed(`turn::${trimmed.toLowerCase()}::${step ?? ""}::${runId ?? ""}`);
  const count = pickStepCount(seed);
  const isCohortStart = /\b(?:start|create|build|make|launch)\b.*\b(?:cohort|course|curriculum|studio|workspace|project)\b|\bcreate\s+my\s+own\b/i.test(trimmed);
  const isCohortSearch = /\b(?:search|find|look\s+for|similar|browse)\b.*\b(?:cohorts?|courses?|projects?|templates?)\b/i.test(trimmed);
  const isNextStepsQuery = /\b(?:what\s+should\s+i\s+do|where\s+do\s+i\s+start|how\s+do\s+i\s+start|what\s+now|next\s+step|help\s+me\s+start)\b/i.test(trimmed);
  let pool;
  if (isCohortStart) {
    pool = [
      ["Reading your studio request", "Noting your cohort preferences", "Locking in your cohort direction"],
      ["Preparing cohort creation studio", "Configuring your curriculum workspace", "Spinning up the studio canvas"],
      ["Structuring starting options", "Setting up material & goal pathways", "Aligning study pacing defaults"],
      ["Opening cohort studio", "Launching your builder workspace", "Handing off to the studio canvas"],
      ["Drafting your kickoff guide", "Putting together initial suggestions", "Ready to build together"]
    ];
  } else if (isCohortSearch) {
    pool = [
      ["Reading your search refinement", "Parsing your updated criteria", "Checking your topic filters"],
      ["Understanding your learning goal", "Mapping related subject areas", "Scoping target skill level"],
      ["Looking for similar cohorts", "Scanning community study groups", "Searching public cohort directory"],
      ["Comparing cohort syllabi & pacing", "Filtering closest topic matches", "Weighing curriculum overlap"],
      ["Summarizing cohort options", "Preparing recommendations", "Wrapping up search insights"]
    ];
  } else if (isNextStepsQuery) {
    pool = [
      ["Checking where we are in your studio", "Reading your question", "Reviewing your current workspace state"],
      [
        shortTopic ? `Looking at your ${shortTopic} goal` : "Reviewing your learning goal",
        "Evaluating the best starting angle",
        "Mapping practical first milestones"
      ],
      ["Sketching a clear action plan", "Weighing self-paced vs. source-led paths", "Organizing concrete next steps"],
      ["Tailoring recommendations to your pace", "Picking the highest-leverage first move", "Structuring a week-by-week preview"],
      ["Drafting your next-steps guide", "Putting together clear options", "Polishing your roadmap advice"]
    ];
  } else if (step === "review" || step === "ready" || hasLessons) {
    pool = [
      ["Reading your curriculum feedback", "Parsing your adjustment request", "Checking your lesson notes"],
      ["Reviewing your curriculum structure", "Inspecting current questline modules", "Scanning lesson objectives & flow"],
      ["Evaluating pacing & topic sequence", "Aligning module depth with your goal", "Checking prerequisite transitions"],
      ["Refining lesson breakdown", "Updating syllabus recommendations", "Polishing module takeaways"],
      ["Drafting tailored response", "Summarizing curriculum updates", "Preparing your updated plan"]
    ];
  } else if (step === "material_input" || step === "discovery") {
    pool = [
      ["Reading your source notes", "Parsing your material preferences", "Capturing your reference criteria"],
      ["Analyzing your learning sources", "Scanning source coverage & depth", "Extracting core concepts from materials"],
      ["Connecting sources to your study goal", "Mapping readings to practical milestones", "Identifying high-signal sections"],
      ["Structuring source-backed takeaways", "Organizing reference highlights", "Weighing source difficulty"],
      ["Drafting tailored response", "Synthesizing source insights", "Preparing your study breakdown"]
    ];
  } else {
    pool = [
      ["Processing your query", "Reading your message", "Tuning in to your question", "Unpacking your thought"],
      [
        shortTopic ? `Mapping concepts around ${shortTopic}` : "Mapping your learning pathway",
        "Exploring foundational mental models",
        "Structuring a clear learning arc",
        "Identifying high-impact subtopics"
      ],
      ["Connecting theory to hands-on practice", "Sequencing milestones from basics up", "Curating practical study angles"],
      ["Tailoring depth & weekly rhythm", "Calibrating examples to your goal", "Sharpening key takeaways"],
      ["Drafting tailored response", "Putting together your learning plan", "Weaving everything into a clear reply"]
    ];
  }
  let stageIndices;
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
    const state = idx < runningIdx ? "complete" : idx === runningIdx ? "running" : "pending";
    return {
      id: `turn-step-${idx}`,
      label,
      state
    };
  });
}
function buildVariedSearchSummary({
  goal,
  step,
  status,
  matchCount,
  intentVersion = 0,
  isSearching,
  createCtaLabel = "Create your own cohort",
  resourceSingular = "cohort",
  resourcePlural = "cohorts"
}) {
  if (isSearching) return null;
  const topicLabel = goal?.trim() || "your learning goal";
  const seed = hashSeed(`summary::${topicLabel.toLowerCase()}::${step ?? ""}::${status ?? ""}::${matchCount}::${intentVersion}`);
  if (step === "recommendations") {
    if (status === "failed") {
      const failedTemplates = [
        `I hit a snag while checking public ${resourcePlural} for **${topicLabel}**. I\u2019ve opened the studio panel on the right so you can retry the search or jump straight into **${createCtaLabel}**.`,
        `I couldn\u2019t finish searching public ${resourcePlural} for **${topicLabel}** just now. You can retry from the right-hand panel or click **${createCtaLabel}** to start building right away.`,
        `Our ${resourceSingular} directory didn\u2019t respond in time for **${topicLabel}**, so I\u2019ve opened the studio on the right \u2014 feel free to retry the search or spin up your own custom ${resourceSingular}!`,
        `Something interrupted the ${resourceSingular} lookup for **${topicLabel}**. No worries \u2014 the workspace on the right is open so you can retry or click **${createCtaLabel}** to design your own plan.`
      ];
      return pickDeterministic(failedTemplates, seed);
    }
    if (matchCount > 0) {
      const noun = matchCount === 1 ? resourceSingular : resourcePlural;
      const pron = matchCount === 1 ? "it" : "them";
      const matchTemplates = [
        `I found **${matchCount}** matching community ${noun} for **${topicLabel}** and lined ${pron} up on the right. Browse the matches to join one, or click **${createCtaLabel}** to craft a custom syllabus.`,
        `Good news \u2014 there ${matchCount === 1 ? "is" : "are"} **${matchCount}** active community ${noun} around **${topicLabel}**! Check ${pron} out in the right panel, or hit **${createCtaLabel}** if you want a tailored plan.`,
        `I\u2019ve pulled up **${matchCount}** public ${noun} related to **${topicLabel}** on the right. You can hop into an existing group or click **${createCtaLabel}** to build from scratch.`,
        `We spotted **${matchCount}** community ${noun} exploring **${topicLabel}**! Take a look on the right to see if the pacing fits, or choose **${createCtaLabel}** to design your own journey.`,
        `I scanned our directory for **${topicLabel}** and found **${matchCount}** matching ${noun} (now open on the right). Join a group that resonates, or start fresh with **${createCtaLabel}**.`,
        `There ${matchCount === 1 ? "is" : "are"} **${matchCount}** peer ${noun} for **${topicLabel}** ready to explore on the right. Feel free to join ${pron}, or tell me here how you\u2019d like to customize your own ${resourceSingular}!`
      ];
      return pickDeterministic(matchTemplates, seed);
    }
    const zeroMatchTemplates = [
      `I searched our public ${resourcePlural} for **${topicLabel}**, and no matching community ${resourcePlural} exist yet. I\u2019ve opened the studio on the right \u2014 click **${createCtaLabel}** (or tell me here how you\u2019d like to start) to launch the first one!`,
      `No one has launched a public ${resourceSingular} for **${topicLabel}** yet \u2014 which means you get to pioneer it! Use **${createCtaLabel}** on the right, or tell me your goals here and we\u2019ll sketch the syllabus together.`,
      `I checked our active directory for **${topicLabel}** and came up empty on existing groups. I\u2019ve popped open the builder on the right so you can click **${createCtaLabel}** and shape a custom study plan.`,
      `It looks like **${topicLabel}** is fresh territory in our community ${resourcePlural}! Head over to the panel on the right and hit **${createCtaLabel}**, or reply here with what you want to cover first.`,
      `We don\u2019t have a live community ${resourceSingular} for **${topicLabel}** right now, so I\u2019ve set up the studio on the right for you. Click **${createCtaLabel}** to kick one off \u2014 or ask me to draft a learning roadmap here!`,
      `Zero public ${resourcePlural} matched **${topicLabel}** so far. Let\u2019s build one tailored to you: click **${createCtaLabel}** on the right canvas, or share your background here to get started.`,
      `I scanned our community ${resourcePlural} for **${topicLabel}**, and none are running yet. You can be the first \u2014 click **${createCtaLabel}** on the right or tell me what materials and goals you have in mind!`,
      `No active ${resourcePlural} matched **${topicLabel}** today, so I opened the studio canvas on the right. Hit **${createCtaLabel}** to design your own track, or chat with me here to brainstorm modules!`
    ];
    return pickDeterministic(zeroMatchTemplates, seed);
  }
  const studioOpenedTemplates = [
    `I\u2019ve opened the ${resourceSingular} studio on the right for **${topicLabel}**. Choose your starting point on the canvas or tell me what materials and goals you have in mind!`,
    `Your ${resourceSingular} studio for **${topicLabel}** is live on the right! Pick a starting path on the canvas, or tell me here how you\u2019d like to structure your learning.`,
    `We checked existing ${resourcePlural} for **${topicLabel}** and opened your builder workspace on the right. Select how you want to begin on the canvas, or chat with me here to shape your plan!`,
    `I\u2019ve set up the studio canvas on the right for **${topicLabel}**. You can bring your own sources, let us find materials, or ask me here to sketch an initial roadmap.`,
    `Ready to build your **${topicLabel}** ${resourceSingular}! Use the studio controls on the right to pick your starting point, or tell me about your background and timeline right here.`
  ];
  return pickDeterministic(studioOpenedTemplates, seed);
}
function hasUnansweredInitialUserPrompt(messages) {
  return messages.length > 0 && messages[0]?.role === "user" && (!messages[1] || messages[1].role === "user");
}
function resolveActivityAnchorMessageId(messages, showActivityBubble) {
  if (!showActivityBubble || messages.length === 0) return null;
  if (hasUnansweredInitialUserPrompt(messages)) {
    return messages[0].id;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      return messages[i].id;
    }
  }
  return messages[messages.length - 1].id;
}
function isAnchoredBubbleAtConversationEnd(messages, showActivityBubble, anchorMessageId) {
  if (!showActivityBubble) return false;
  const latest = messages[messages.length - 1];
  return !anchorMessageId || latest?.id === anchorMessageId;
}
function createImplicitActionDetector(rules) {
  return (text, currentStage) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    for (const rule of rules) {
      if (rule.allowedStages && rule.allowedStages.length > 0) {
        if (currentStage === void 0 || !rule.allowedStages.includes(currentStage)) {
          continue;
        }
      }
      if ((rule.ignoreQuestions ?? true) && trimmed.endsWith("?")) {
        continue;
      }
      for (const pattern of rule.patterns) {
        if (pattern.test(trimmed)) {
          return typeof rule.action === "function" ? rule.action(trimmed) : rule.action;
        }
      }
    }
    return null;
  };
}
function resolveSplitCanvasLayout({
  stage,
  centeredStages = ["chat"],
  discoveryStage = "recommendations",
  discoveryStatus
}) {
  if (!stage) return "split";
  if (centeredStages.includes(stage)) return "centered";
  if (stage === discoveryStage && (!discoveryStatus || discoveryStatus === "queued" || discoveryStatus === "running")) {
    return "centered";
  }
  return "split";
}
function createStageSuggestions(map, maxSuggestions = 3) {
  return (stage, ctx) => {
    const entry = (stage ? map[stage] : void 0) ?? map.default;
    if (!entry) return [];
    const list = typeof entry === "function" ? entry(ctx) : entry;
    return list.slice(0, maxSuggestions);
  };
}
export {
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  actionEnvelopeSchema,
  applyJsonPatch,
  buildVariedSearchSteps,
  buildVariedSearchSummary,
  buildVariedSteps,
  buildVariedTurnSteps,
  changeReceiptSchema,
  createImplicitActionDetector,
  createStageSuggestions,
  defineAction,
  entityRefSchema,
  formatShortTopic,
  generateJsonPatch,
  getValueByPointer,
  hasUnansweredInitialUserPrompt,
  hashSeed,
  hostCommandEnvelopeSchema,
  hostCommandReceiptSchema,
  hostResourceBindingSchema,
  interactionEventSchema,
  interactionMessageSchema,
  invertJsonPatch,
  isAnchoredBubbleAtConversationEnd,
  isSupportedProtocolVersion,
  messagePartSchema,
  pickDeterministic,
  pickStepCount,
  reduceInteraction,
  resolveActivityAnchorMessageId,
  resolveSplitCanvasLayout
};
//# sourceMappingURL=index.js.map
