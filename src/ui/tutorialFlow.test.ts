import { describe, expect, it } from 'vitest';
import {
  evaluateTutorialStep,
  getNextTutorialStepId,
  getPreviousTutorialStepId,
  getTutorialPlan,
  getTutorialStepProgress,
  type TutorialRuntimeState
} from './tutorialFlow';

const baseState: TutorialRuntimeState = {
  authReady: true,
  activeTab: 'courses',
  showCourseActions: true,
  visibleNotDownloadedCount: 4,
  selectedCount: 2,
  queueItemsCount: 2,
  hasRunnableQueueItems: true,
  isDownloading: false,
  completedStepIds: new Set()
};

describe('tutorialFlow.getTutorialPlan', () => {
  it('includes setup steps when auth is not ready at tutorial start', () => {
    expect(getTutorialPlan(false)).toEqual([
      'open_courses_tab',
      'open_mycourses',
      'recheck_setup',
      'open_course_actions',
      'select_not_downloaded',
      'add_selected_to_queue',
      'go_to_queue',
      'start_queue',
      'advanced_tips'
    ]);
  });

  it('omits setup steps when auth is already ready', () => {
    expect(getTutorialPlan(true)).toEqual([
      'open_courses_tab',
      'open_course_actions',
      'select_not_downloaded',
      'add_selected_to_queue',
      'go_to_queue',
      'start_queue',
      'advanced_tips'
    ]);
  });
});

describe('tutorialFlow.plan navigation', () => {
  const plan = getTutorialPlan(true);

  it('uses the active plan for progress', () => {
    expect(getTutorialStepProgress('add_selected_to_queue', plan)).toEqual({
      current: 4,
      total: 7
    });
  });

  it('moves linearly without fallback detours', () => {
    expect(getNextTutorialStepId('open_courses_tab', plan)).toBe('open_course_actions');
    expect(getPreviousTutorialStepId('open_course_actions', plan)).toBe('open_courses_tab');
  });
});

describe('tutorialFlow.evaluateTutorialStep', () => {
  it('requires setup completion for re-check setup', () => {
    const evaluation = evaluateTutorialStep('recheck_setup', {
      ...baseState,
      authReady: false,
      completedStepIds: new Set(['recheck_setup'])
    });

    expect(evaluation.isComplete).toBe(false);
    expect(evaluation.blockerMessage).toContain('Setup is still incomplete');
  });

  it('auto-completes selection step when no non-downloaded recordings are available', () => {
    const evaluation = evaluateTutorialStep('select_not_downloaded', {
      ...baseState,
      visibleNotDownloadedCount: 0,
      selectedCount: 0
    });

    expect(evaluation.isComplete).toBe(true);
    expect(evaluation.blockerMessage).toBeNull();
  });

  it('requires queue to be populated before add-to-queue step completes', () => {
    const evaluation = evaluateTutorialStep('add_selected_to_queue', {
      ...baseState,
      queueItemsCount: 0
    });

    expect(evaluation.isComplete).toBe(false);
    expect(evaluation.blockerMessage).toContain('Click Add Selected To Queue');
  });

  it('auto-completes add-to-queue step when there is nothing to download', () => {
    const evaluation = evaluateTutorialStep('add_selected_to_queue', {
      ...baseState,
      visibleNotDownloadedCount: 0,
      selectedCount: 0,
      queueItemsCount: 0
    });

    expect(evaluation.isComplete).toBe(true);
    expect(evaluation.blockerMessage).toBeNull();
  });

  it('allows direct continue on start-queue once queue tab is open', () => {
    const evaluation = evaluateTutorialStep('start_queue', {
      ...baseState,
      activeTab: 'queue'
    });

    expect(evaluation.requiresTargetClick).toBe(false);
    expect(evaluation.isComplete).toBe(true);
    expect(evaluation.blockerMessage).toBeNull();
  });

  it('blocks start-queue when queue tab is not open', () => {
    const evaluation = evaluateTutorialStep('start_queue', {
      ...baseState,
      activeTab: 'courses'
    });

    expect(evaluation.requiresTargetClick).toBe(false);
    expect(evaluation.isComplete).toBe(false);
    expect(evaluation.blockerMessage).toContain('Open the Queue tab first.');
  });
});
