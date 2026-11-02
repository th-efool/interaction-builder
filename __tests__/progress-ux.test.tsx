// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  buildVariedSearchSteps,
  buildVariedSearchSummary,
  buildVariedSteps,
  buildVariedTurnSteps,
  createImplicitActionDetector,
  createStageSuggestions,
  hasUnansweredInitialUserPrompt,
  isAnchoredBubbleAtConversationEnd,
  resolveActivityAnchorMessageId,
  resolveSplitCanvasLayout,
} from '../src/core/progress-ux';
import { InteractionStepTrail } from '../src/react/progress-ui';

describe('interaction-builder progress-ux & InteractionStepTrail', () => {
  it('generates variable-length (2 to 5 steps) checklists and varied summaries across queries', () => {
    const queries = [
      'robotics engineering',
      'distributed consensus',
      'quantum computing',
      'webgl shaders',
      'rust async runtime',
      'biochemistry',
      'music theory',
      'macroeconomics',
      'linear algebra',
      'compiler design',
    ];

    const counts = new Set<number>();
    const summaries = new Set<string>();

    for (const q of queries) {
      const steps = buildVariedSearchSteps({
        goal: q,
        query: q,
        intentVersion: 0,
        isSearching: true,
        activePhaseIndex: 1,
      });
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps.length).toBeLessThanOrEqual(5);
      counts.add(steps.length);

      const summary = buildVariedSearchSummary({
        goal: q,
        step: 'recommendations',
        status: 'ready',
        matchCount: 0,
        isSearching: false,
      });
      expect(summary).toBeTruthy();
      summaries.add(summary!);
    }

    expect(counts.size).toBeGreaterThanOrEqual(3);
    expect(summaries.size).toBeGreaterThanOrEqual(3);
  });

  it('supports generic buildVariedSteps with custom domain pools and topic interpolation', () => {
    const steps = buildVariedSteps({
      seedKey: 'custom-domain-seed-1',
      topic: 'Q4 Product Launch',
      isActive: true,
      activePhaseIndex: 1,
      pools: {
        stage1: ['Parsing {{topic}} brief'],
        stage2: ['Scoping milestones for {{topic}}'],
        stage3: ['Mapping dependencies'],
        stage4: ['Checking timeline constraints'],
        stage5: ['Finalizing {{topic}} board'],
      },
    });
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.length).toBeLessThanOrEqual(5);
    expect(steps[0].label).toContain('Q4 Product Launch');
    expect(steps[0].state).toBe('complete');
    expect(steps[1].state).toBe('running');
  });

  it('anchors activity bubble chronologically after unanswered initial user message even when follow-up messages arrive', () => {
    const messages = [
      { id: 'm-initial', role: 'user' },
      { id: 'm-followup-user', role: 'user' },
      { id: 'm-followup-assistant', role: 'assistant' },
    ];

    expect(hasUnansweredInitialUserPrompt(messages)).toBe(true);
    const anchorId = resolveActivityAnchorMessageId(messages, true);
    expect(anchorId).toBe('m-initial');
    expect(isAnchoredBubbleAtConversationEnd(messages, true, anchorId)).toBe(false);
  });

  it('detects implicit natural-language actions and ignores questions', () => {
    type TestAction = { type: 'open_studio' } | { type: 'use_sources' };
    const detect = createImplicitActionDetector<TestAction, 'chat' | 'recommendations' | 'ready'>([
      {
        id: 'sources',
        allowedStages: ['chat', 'recommendations'],
        patterns: [/\bi\s+have\s+my\s+own\s+materials?\b/i],
        action: { type: 'use_sources' },
      },
      {
        id: 'studio',
        allowedStages: ['chat', 'recommendations'],
        patterns: [/\b(?:start|create|build)\s+(?:a\s+|my\s+)?cohort\b/i],
        action: { type: 'open_studio' },
      },
    ]);

    expect(detect('I want to start a cohort', 'chat')).toEqual({ type: 'open_studio' });
    expect(detect('Can I start a cohort?', 'chat')).toBeNull();
    expect(detect('I want to start a cohort', 'ready')).toBeNull();
    expect(detect('I have my own materials', 'recommendations')).toEqual({ type: 'use_sources' });
  });

  it('resolves delayed split-canvas layout ("Tadada~" transition) and stage suggestions', () => {
    expect(resolveSplitCanvasLayout({ stage: 'chat' })).toBe('centered');
    expect(resolveSplitCanvasLayout({ stage: 'recommendations', discoveryStatus: 'running' })).toBe('centered');
    expect(resolveSplitCanvasLayout({ stage: 'recommendations', discoveryStatus: 'ready' })).toBe('split');
    expect(resolveSplitCanvasLayout({ stage: 'starting_point', discoveryStatus: 'ready' })).toBe('split');

    const getSuggestions = createStageSuggestions<'chat' | 'review', { topic?: string }>({
      chat: ctx => [{ id: '1', label: 'Start', prompt: `Start ${ctx.topic ?? 'now'}` }],
      default: [{ id: 'd', label: 'Default', prompt: 'Help' }],
    });

    expect(getSuggestions('chat', { topic: 'Rust' })[0].prompt).toBe('Start Rust');
    expect(getSuggestions('review', {})[0].label).toBe('Default');
  });

  it('renders InteractionStepTrail with accessible step states and default inline styles', () => {
    const steps = buildVariedTurnSteps({
      latestUserText: 'what should i do now',
      goal: 'robotics engineering',
      step: 'recommendations',
      activePhaseIndex: 1,
    });

    render(<InteractionStepTrail steps={steps} ariaLabel="Turn progress" />);
    const list = screen.getByRole('list', { name: 'Turn progress' });
    expect(list).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items.length).toBe(steps.length);
    expect(items[0].getAttribute('data-step-state')).toBe('complete');
    expect(items[1].getAttribute('data-step-state')).toBe('running');
    expect(items[1].getAttribute('aria-current')).toBe('step');
  });
});
