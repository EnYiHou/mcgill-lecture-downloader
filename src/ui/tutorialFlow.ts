export type TutorialTab = 'courses' | 'library' | 'queue' | 'guide';

export type TutorialStepId =
  | 'open_courses_tab'
  | 'open_mycourses'
  | 'recheck_setup'
  | 'open_course_actions'
  | 'select_not_downloaded'
  | 'add_selected_to_queue'
  | 'go_to_queue'
  | 'start_queue'
  | 'advanced_tips';

export interface TutorialStep {
  id: TutorialStepId;
  title: string;
  body: string;
  tab: TutorialTab;
  targetSelector?: string;
  targetHint?: string;
}

export interface TutorialRuntimeState {
  authReady: boolean;
  activeTab: TutorialTab;
  showCourseActions: boolean;
  visibleNotDownloadedCount: number;
  selectedCount: number;
  queueItemsCount: number;
  hasRunnableQueueItems: boolean;
  isDownloading: boolean;
  completedStepIds: ReadonlySet<TutorialStepId>;
}

export interface TutorialStepEvaluation {
  isComplete: boolean;
  blockerMessage: string | null;
  requiresTargetClick: boolean;
}

const STEPS: readonly TutorialStep[] = [
  {
    id: 'open_courses_tab',
    title: 'Open Courses Tab',
    body: 'Start in Courses. This is where setup checks, selection, and queueing begin.',
    tab: 'courses',
    targetSelector: '[data-tutorial-id="tab-courses"]',
    targetHint: 'Click the Courses tab in the left menu.'
  },
  {
    id: 'open_mycourses',
    title: 'Open myCourses',
    body: 'Open myCourses, log in, and play one lecture so the extension can capture session data.',
    tab: 'courses',
    targetSelector: '[data-tutorial-id="open-mycourses"]',
    targetHint: 'Click Open myCourses.'
  },
  {
    id: 'recheck_setup',
    title: 'Re-check Setup',
    body: 'After playing a lecture in myCourses, return here and refresh captured session data.',
    tab: 'courses',
    targetSelector: '[data-tutorial-id="recheck-setup"]',
    targetHint: 'Click Re-check Setup.'
  },
  {
    id: 'open_course_actions',
    title: 'Open Course Actions',
    body: 'Course Actions contains refresh and bulk-selection tools.',
    tab: 'courses',
    targetSelector: '[data-tutorial-id="course-actions-toggle"]',
    targetHint: 'Click Course Actions.'
  },
  {
    id: 'select_not_downloaded',
    title: 'Select Non-downloaded',
    body: 'Use this to quickly select recordings you have not downloaded yet.',
    tab: 'courses',
    targetSelector: '[data-tutorial-id="select-all-not-downloaded"]',
    targetHint: 'Click SELECT ALL NON-DOWNLOADED.'
  },
  {
    id: 'add_selected_to_queue',
    title: 'Add Selected To Queue',
    body: 'Add your current selection to the download queue.',
    tab: 'courses',
    targetSelector: '[data-tutorial-id="add-selected-to-queue"]',
    targetHint: 'Click Add Selected To Queue at the bottom.'
  },
  {
    id: 'go_to_queue',
    title: 'Go To Queue',
    body: 'Queue is where you run and manage downloads.',
    tab: 'queue',
    targetSelector: '[data-tutorial-id="tab-queue"]',
    targetHint: 'Click Queue in the left menu.'
  },
  {
    id: 'start_queue',
    title: 'Start Queue',
    body: 'Start Queue begins all runnable jobs. You can click Continue directly if you do not want to start yet.',
    tab: 'queue',
    targetSelector: '[data-tutorial-id="start-queue"]',
    targetHint: 'Optionally click Start Queue, then Continue.'
  },
  {
    id: 'advanced_tips',
    title: 'Advanced Tips',
    body: 'Minimize (title bar button), Clear Queue, Library visibility toggles, and Guide > Replay Tutorial are available anytime.',
    tab: 'guide',
    targetHint: 'You are done with the core flow.'
  }
] as const;

const PLAN_WITH_SETUP: readonly TutorialStepId[] = [
  'open_courses_tab',
  'open_mycourses',
  'recheck_setup',
  'open_course_actions',
  'select_not_downloaded',
  'add_selected_to_queue',
  'go_to_queue',
  'start_queue',
  'advanced_tips'
];

const PLAN_WITHOUT_SETUP: readonly TutorialStepId[] = [
  'open_courses_tab',
  'open_course_actions',
  'select_not_downloaded',
  'add_selected_to_queue',
  'go_to_queue',
  'start_queue',
  'advanced_tips'
];

export const TUTORIAL_STEPS = STEPS;
export const FIRST_TUTORIAL_STEP_ID: TutorialStepId = 'open_courses_tab';

const stepById = new Map<TutorialStepId, TutorialStep>(STEPS.map((step) => [step.id, step]));

export function getTutorialPlan(authReadyAtStart: boolean): TutorialStepId[] {
  return authReadyAtStart ? [...PLAN_WITHOUT_SETUP] : [...PLAN_WITH_SETUP];
}

export function getTutorialStep(stepId: TutorialStepId): TutorialStep {
  return stepById.get(stepId) ?? STEPS[0];
}

export function getTutorialStepProgress(
  stepId: TutorialStepId,
  planStepIds: readonly TutorialStepId[]
): { current: number; total: number } {
  const index = Math.max(0, planStepIds.indexOf(stepId));
  return {
    current: index + 1,
    total: planStepIds.length
  };
}

export function getNextTutorialStepId(stepId: TutorialStepId, planStepIds: readonly TutorialStepId[]): TutorialStepId {
  const index = planStepIds.indexOf(stepId);
  if (index < 0 || index >= planStepIds.length - 1) {
    return planStepIds[planStepIds.length - 1];
  }
  return planStepIds[index + 1];
}

export function getPreviousTutorialStepId(stepId: TutorialStepId, planStepIds: readonly TutorialStepId[]): TutorialStepId {
  const index = planStepIds.indexOf(stepId);
  if (index <= 0) {
    return planStepIds[0];
  }
  return planStepIds[index - 1];
}

export function evaluateTutorialStep(stepId: TutorialStepId, state: TutorialRuntimeState): TutorialStepEvaluation {
  const completed = state.completedStepIds;

  switch (stepId) {
    case 'open_courses_tab': {
      return {
        isComplete: completed.has(stepId),
        blockerMessage: state.activeTab === 'courses' ? null : 'Open the Courses tab from the left menu first.',
        requiresTargetClick: true
      };
    }
    case 'open_mycourses': {
      return {
        isComplete: completed.has(stepId),
        blockerMessage: state.activeTab === 'courses' ? null : 'Go back to Courses so the setup buttons are visible.',
        requiresTargetClick: true
      };
    }
    case 'recheck_setup': {
      return {
        isComplete: completed.has(stepId) && state.authReady,
        blockerMessage: state.authReady
          ? null
          : 'Setup is still incomplete. Play one lecture in myCourses, then click Re-check Setup again.',
        requiresTargetClick: true
      };
    }
    case 'open_course_actions': {
      if (state.activeTab !== 'courses') {
        return {
          isComplete: false,
          blockerMessage: 'Open the Courses tab first.',
          requiresTargetClick: false
        };
      }
      return {
        isComplete: state.showCourseActions,
        blockerMessage: state.showCourseActions ? null : 'Open Course Actions to reveal bulk tools.',
        requiresTargetClick: false
      };
    }
    case 'select_not_downloaded': {
      if (state.activeTab !== 'courses') {
        return {
          isComplete: false,
          blockerMessage: 'Open the Courses tab first.',
          requiresTargetClick: false
        };
      }
      if (!state.showCourseActions) {
        return {
          isComplete: false,
          blockerMessage: 'Open Course Actions first.',
          requiresTargetClick: false
        };
      }
      if (state.visibleNotDownloadedCount === 0) {
        return {
          isComplete: true,
          blockerMessage: null,
          requiresTargetClick: false
        };
      }
      return {
        isComplete: state.selectedCount > 0,
        blockerMessage: state.selectedCount > 0 ? null : 'Select at least one recording (use SELECT ALL NON-DOWNLOADED).',
        requiresTargetClick: false
      };
    }
    case 'add_selected_to_queue': {
      if (state.queueItemsCount > 0) {
        return {
          isComplete: true,
          blockerMessage: null,
          requiresTargetClick: false
        };
      }
      if (state.activeTab !== 'courses') {
        return {
          isComplete: false,
          blockerMessage: 'Open the Courses tab first.',
          requiresTargetClick: false
        };
      }
      if (state.visibleNotDownloadedCount === 0 && state.selectedCount === 0 && state.queueItemsCount === 0) {
        return {
          isComplete: true,
          blockerMessage: null,
          requiresTargetClick: false
        };
      }
      if (state.selectedCount === 0) {
        return {
          isComplete: false,
          blockerMessage: 'No recordings are selected yet.',
          requiresTargetClick: false
        };
      }
      return {
        isComplete: state.queueItemsCount > 0,
        blockerMessage: state.queueItemsCount > 0 ? null : 'Click Add Selected To Queue to continue.',
        requiresTargetClick: false
      };
    }
    case 'go_to_queue': {
      return {
        isComplete: state.activeTab === 'queue' || completed.has(stepId),
        blockerMessage: null,
        requiresTargetClick: true
      };
    }
    case 'start_queue': {
      if (state.activeTab !== 'queue') {
        return {
          isComplete: false,
          blockerMessage: 'Open the Queue tab first.',
          requiresTargetClick: false
        };
      }
      return {
        isComplete: true,
        blockerMessage: null,
        requiresTargetClick: false
      };
    }
    case 'advanced_tips':
    default: {
      return {
        isComplete: true,
        blockerMessage: null,
        requiresTargetClick: false
      };
    }
  }
}
