import {
  Suspense,
  lazy,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { detectMediaSizeBytes, downloadAndRemuxMedia } from '../shared/download';
import { createDownloadMarker, createLegacyFilenameMarker, isDownloaded } from '../shared/downloadMarkers';
import { mapWithConcurrency } from '../shared/async';
import { fetchCourseMediaList, resolveCourseDigit } from '../shared/mcgillApi';
import {
  evaluateTutorialStep,
  FIRST_TUTORIAL_STEP_ID,
  getTutorialPlan,
  getNextTutorialStepId,
  getPreviousTutorialStepId,
  getTutorialStep,
  getTutorialStepProgress,
  type TutorialRuntimeState,
  type TutorialStepId,
  type TutorialTab
} from './tutorialFlow';
import { buildTutorialSpotlightPanels, type SpotlightPanels } from './tutorialSpotlight';
import {
  readAuthReadiness,
  readDownloadedItems,
  readRequiredAuthData,
  readUiPreferences,
  storageGet,
  storageSet,
  writeDownloadedItems
} from '../shared/storage';
import type {
  CourseCatalogEntry,
  DownloadQueueItem,
  DownloadQueueState,
  MediaRecordingDto,
  QueueItemStatus,
  UiPreferences
} from '../shared/types';
const MouseEffectBackground = lazy(async () => {
  const module = await import('./components/MouseEffectBackground');
  return { default: module.MouseEffectBackground };
});

interface UiMediaItem {
  key: string;
  courseDigit: string;
  id: string;
  downloadMarker: string;
  filename: string;
  recordingName: string;
  recordingTime: string;
  uploadedAt: string | null;
  videoType: string;
  formatOptions: UiFormatOption[];
  captionSrc: string | null;
  captionLanguage: string | null;
  captionLabel: string | null;
}

interface UiFormatOption {
  label: string;
  resolution: string | null;
}

interface UiCourse {
  courseDigit: string;
  courseListId: string | null;
  title: string;
  media: UiMediaItem[];
  expanded: boolean;
}

interface AuthState {
  stoken: string;
  etime: string;
  bearer: string;
  coursesList: string[];
  cookieHeader: string;
}

interface AuthReadinessState {
  hasStoken: boolean;
  hasEtime: boolean;
  hasBearer: boolean;
  hasCourses: boolean;
  hasCookies: boolean;
}

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'default' | 'danger';
  resolve: (confirmed: boolean) => void;
}

type MenuTab = TutorialTab;

const TAB_ORDER: readonly MenuTab[] = ['courses', 'library', 'queue', 'guide'];
const PARENT_MESSAGE_SOURCE = 'mclecture';
const PARENT_MESSAGE_TYPE_DOWNLOAD_STATE = 'download-state';

function normalizeFilename(courseName: string, index: number): string {
  return `${courseName}_${index}`.replace(/\s+/g, '');
}

function ensureTitleHasCourseId(title: string, courseDigit: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    return `Course ID: ${courseDigit}`;
  }
  if (trimmed.includes(', ID:')) {
    return trimmed;
  }
  return `${trimmed}, ID: ${courseDigit}`;
}

function buildCourseTitle(fallback: string | undefined, mediaList: MediaRecordingDto[], courseDigit: string): string {
  const fallbackTitle = fallback?.trim();
  const mediaTitle = mediaList[0]?.courseName?.trim();

  // Prefer context_title from LTI when it is meaningful. Some media payloads only expose "Course ID: ...".
  if (fallbackTitle && !isFallbackCourseIdTitle(fallbackTitle)) {
    return ensureTitleHasCourseId(fallbackTitle, courseDigit);
  }
  if (mediaTitle && !isFallbackCourseIdTitle(mediaTitle)) {
    return ensureTitleHasCourseId(mediaTitle, courseDigit);
  }
  if (fallbackTitle) {
    return ensureTitleHasCourseId(fallbackTitle, courseDigit);
  }
  if (mediaTitle) {
    return ensureTitleHasCourseId(mediaTitle, courseDigit);
  }
  return `Course ID: ${courseDigit}`;
}

function isFallbackCourseIdTitle(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  return value.trim().startsWith('Course ID:');
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isUnauthorizedError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('401') || message.includes('unauthorized');
}

function normalizeSearchText(value: unknown): string {
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString().toLowerCase();
  }
  return '';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function dedupeCourseCatalog(items: CourseCatalogEntry[]): CourseCatalogEntry[] {
  const map = new Map<string, CourseCatalogEntry>();
  items.forEach((item) => {
    if (!item.courseDigit) {
      return;
    }
    map.set(item.courseDigit, item);
  });
  return Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title));
}

function isAuthReady(readiness: AuthReadinessState | null): boolean {
  if (!readiness) {
    return false;
  }

  return readiness.hasStoken && readiness.hasEtime && readiness.hasBearer && readiness.hasCourses && readiness.hasCookies;
}

function resolveParentTargetOrigin(value: string | null): string {
  if (!value) {
    return '*';
  }

  try {
    const origin = new URL(value).origin;
    if (origin.startsWith('http://') || origin.startsWith('https://')) {
      return origin;
    }
  } catch {
    return '*';
  }

  return '*';
}

function statusLabel(status: QueueItemStatus): string {
  switch (status) {
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'downloading':
      return 'Downloading';
    case 'canceled':
      return 'Canceled';
    default:
      return 'Queued';
  }
}

function normalizeFormatLabel(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  const upper = value.trim().toUpperCase();
  if (upper.endsWith('MP4') && upper.length > 3) {
    return upper.slice(0, -3);
  }

  return upper;
}

function buildFormatOptions(media: MediaRecordingDto): UiFormatOption[] {
  const byLabel = new Map<string, string | null>();

  media.sources.forEach((source) => {
    const label = normalizeFormatLabel(source.label);
    if (!label) {
      return;
    }
    byLabel.set(label, source.res ?? null);
  });

  media.downloads?.forEach((download) => {
    const label = normalizeFormatLabel(download.type ?? download.label);
    if (!label || byLabel.has(label)) {
      return;
    }
    byLabel.set(label, download.res ?? null);
  });

  if (byLabel.size === 0) {
    byLabel.set('VGA', null);
  }

  return Array.from(byLabel.entries()).map(([label, resolution]) => ({
    label,
    resolution
  }));
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return 'Unknown';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return 'Unknown';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals = unitIndex >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toFixedRectStyle(rect: { left: number; top: number; width: number; height: number }): CSSProperties {
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  };
}

export function App() {
  const [activeTab, setActiveTab] = useState<MenuTab>('courses');
  const [courses, setCourses] = useState<UiCourse[]>([]);
  const [courseCatalog, setCourseCatalog] = useState<CourseCatalogEntry[]>([]);
  const [hiddenCourseDigits, setHiddenCourseDigits] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authReadiness, setAuthReadiness] = useState<AuthReadinessState | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCourseActions, setShowCourseActions] = useState(false);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>({
    performanceMode: false,
    reducedMotion: false,
    showVisualEffects: true,
    menuCollapsed: false,
    remuxToMp4: true
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);
  const [activeDownloadTotal, setActiveDownloadTotal] = useState(0);
  const [activeDownloadCompleted, setActiveDownloadCompleted] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [queueItems, setQueueItems] = useState<DownloadQueueItem[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [showQuickTutorial, setShowQuickTutorial] = useState(false);
  const [quickTutorialPlanStepIds, setQuickTutorialPlanStepIds] = useState<TutorialStepId[]>(() => getTutorialPlan(false));
  const [quickTutorialStepId, setQuickTutorialStepId] = useState<TutorialStepId>(FIRST_TUTORIAL_STEP_ID);
  const [tutorialCompletedStepIds, setTutorialCompletedStepIds] = useState<Set<TutorialStepId>>(new Set());
  const [tutorialStartedWithAuthReady, setTutorialStartedWithAuthReady] = useState(false);
  const [tutorialTargetVisible, setTutorialTargetVisible] = useState(false);
  const [tutorialCoachStyle, setTutorialCoachStyle] = useState<CSSProperties>({});
  const [tutorialPointerStyle, setTutorialPointerStyle] = useState<CSSProperties>({});
  const [tutorialCoachPlacement, setTutorialCoachPlacement] = useState<'top' | 'bottom' | 'left' | 'right'>('bottom');
  const [tutorialSpotlightPanels, setTutorialSpotlightPanels] = useState<SpotlightPanels | null>(null);
  const [mediaSizeBytesByKey, setMediaSizeBytesByKey] = useState<Record<string, number | null>>({});
  const [selectedFormatByKey, setSelectedFormatByKey] = useState<Record<string, string>>({});
  const [embedCaptions, setEmbedCaptions] = useState(true);

  const abortControllerRef = useRef<AbortController | null>(null);
  const appShellRef = useRef<HTMLElement | null>(null);
  const stopRequestedRef = useRef(false);
  const cancelRequestedKeysRef = useRef<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const loadRunRef = useRef(0);
  const parentOriginRef = useRef<string>('*');
  const channelRef = useRef('');
  const tutorialCoachRef = useRef<HTMLElement | null>(null);
  const tutorialTargetRef = useRef<Element | null>(null);
  const tutorialStepEntryRef = useRef<TutorialStepId | null>(null);
  const tutorialPositionRafRef = useRef<number | null>(null);
  const tutorialMenuCollapsedAtStartRef = useRef<boolean | null>(null);
  const mediaSizeFetchInFlightRef = useRef<Set<string>>(new Set());
  const keepAwakeRequestedRef = useRef(false);
  const logoUrl = chrome.runtime.getURL('icons/icon.png');

  const mediaByKey = useMemo(() => {
    const map = new Map<string, UiMediaItem>();
    courses.forEach((course) => {
      course.media.forEach((media) => {
        map.set(media.key, media);
      });
    });
    return map;
  }, [courses]);

  const queueStats = useMemo(() => {
    const stats = {
      total: queueItems.length,
      queued: 0,
      downloading: 0,
      done: 0,
      failed: 0,
      canceled: 0
    };

    queueItems.forEach((item) => {
      if (item.status === 'queued') {
        stats.queued += 1;
      } else if (item.status === 'downloading') {
        stats.downloading += 1;
      } else if (item.status === 'done') {
        stats.done += 1;
      } else if (item.status === 'failed') {
        stats.failed += 1;
      } else if (item.status === 'canceled') {
        stats.canceled += 1;
      }
    });

    return stats;
  }, [queueItems]);
  const hasRunnableQueueItems = useMemo(
    () => queueItems.some((item) => item.status === 'queued' || item.status === 'failed' || item.status === 'canceled'),
    [queueItems]
  );

  const visibleCourses = useMemo(
    () => courses.filter((course) => !hiddenCourseDigits.has(course.courseDigit)),
    [courses, hiddenCourseDigits]
  );

  const filteredCourses = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) {
      return visibleCourses;
    }

    return visibleCourses
      .map((course) => {
        const titleMatches = course.title.toLowerCase().includes(needle);
        const media = course.media.filter(
          (item) =>
            normalizeSearchText(item.recordingName).includes(needle) ||
            normalizeSearchText(item.filename).includes(needle) ||
            normalizeSearchText(item.recordingTime).includes(needle) ||
            normalizeSearchText(item.uploadedAt).includes(needle)
        );

        if (titleMatches) {
          return course;
        }

        if (media.length === 0) {
          return null;
        }

        return {
          ...course,
          media,
          expanded: true
        } satisfies UiCourse;
      })
      .filter((course): course is UiCourse => Boolean(course));
  }, [searchTerm, visibleCourses]);

  const progressPercent = useMemo(() => {
    if (!activeDownloadTotal) {
      return 0;
    }
    return Math.round((activeDownloadCompleted / activeDownloadTotal) * 100);
  }, [activeDownloadCompleted, activeDownloadTotal]);

  const authReady = isAuthReady(authReadiness);
  const isMenuCollapsed = uiPreferences.menuCollapsed;

  const isMediaDownloaded = useCallback(
    (item: UiMediaItem): boolean => isDownloaded(downloaded, item.downloadMarker, item.filename),
    [downloaded]
  );
  const allVisibleMediaKeys = useMemo(
    () => visibleCourses.flatMap((course) => course.media.map((media) => media.key)),
    [visibleCourses]
  );
  const allVisibleNotDownloadedMediaKeys = useMemo(
    () =>
      visibleCourses.flatMap((course) =>
        course.media.filter((media) => !isMediaDownloaded(media)).map((media) => media.key)
      ),
    [isMediaDownloaded, visibleCourses]
  );
  const areAllVisibleSelected = useMemo(
    () => allVisibleMediaKeys.length > 0 && allVisibleMediaKeys.every((key) => selected.has(key)),
    [allVisibleMediaKeys, selected]
  );
  const areAllVisibleNotDownloadedSelected = useMemo(
    () =>
      allVisibleNotDownloadedMediaKeys.length > 0 &&
      allVisibleNotDownloadedMediaKeys.every((key) => selected.has(key)),
    [allVisibleNotDownloadedMediaKeys, selected]
  );
  const tutorialRuntimeState = useMemo<TutorialRuntimeState>(
    () => ({
      authReady,
      activeTab,
      showCourseActions,
      visibleNotDownloadedCount: allVisibleNotDownloadedMediaKeys.length,
      selectedCount: selected.size,
      queueItemsCount: queueItems.length,
      hasRunnableQueueItems,
      isDownloading,
      completedStepIds: tutorialCompletedStepIds
    }),
    [
      activeTab,
      allVisibleNotDownloadedMediaKeys.length,
      authReady,
      hasRunnableQueueItems,
      isDownloading,
      queueItems.length,
      selected.size,
      showCourseActions,
      tutorialCompletedStepIds
    ]
  );
  const currentTutorialStep = useMemo(() => getTutorialStep(quickTutorialStepId), [quickTutorialStepId]);
  const tutorialProgress = useMemo(
    () => getTutorialStepProgress(quickTutorialStepId, quickTutorialPlanStepIds),
    [quickTutorialPlanStepIds, quickTutorialStepId]
  );
  const tutorialEvaluation = useMemo(
    () => evaluateTutorialStep(quickTutorialStepId, tutorialRuntimeState),
    [quickTutorialStepId, tutorialRuntimeState]
  );
  const isLastTutorialStep = tutorialProgress.current === tutorialProgress.total;
  const showSetupReadyNote = tutorialStartedWithAuthReady && currentTutorialStep.id === 'open_courses_tab';
  const tutorialUseBlurSpotlight = !uiPreferences.performanceMode && !uiPreferences.reducedMotion;

  const persistQueue = useCallback(async (items: DownloadQueueItem[], active: boolean, paused: boolean) => {
    const persistedItems = items.filter((item) => item.status !== 'done');
    const completed = persistedItems.filter((item) => item.status === 'done').length;
    const queueState: DownloadQueueState = {
      active,
      paused,
      completed,
      total: persistedItems.length,
      items: persistedItems,
      updatedAt: Date.now()
    };
    await storageSet('downloadQueueState', queueState);
  }, []);

  const hydrateQueueItem = useCallback((item: DownloadQueueItem): DownloadQueueItem => {
    const courseDigit = item.courseDigit || item.key.split('::')[0] || 'unknown-course';
    const downloadMarker = item.downloadMarker || createDownloadMarker(courseDigit, item.rid);

    return {
      ...item,
      courseDigit,
      downloadMarker
    };
  }, []);

  const buildCourse = useCallback(
    async (courseDigit: string, bearer: string, title: string | undefined, courseListId: string | null) => {
      const mediaList = await fetchCourseMediaList(courseDigit, bearer);
      if (mediaList.length === 0) {
        return null;
      }

      const media = mediaList.map((item, index) => {
        const filename = normalizeFilename(mediaList[0].courseName, index);
        const downloadMarker = createDownloadMarker(courseDigit, item.id);
        const uploadedAt = item.dateCreated ?? item.dateTime ?? item.recordingTime ?? null;
        const formatOptions = buildFormatOptions(item);
        const primaryCaption = item.captions?.find((caption) => typeof caption.src === 'string' && caption.src.trim().length > 0) ?? null;
        return {
          key: `${downloadMarker}::${filename}`,
          courseDigit,
          id: item.id,
          downloadMarker,
          filename,
          recordingName: item.recordingName ?? 'Recording Name Unavailable',
          recordingTime: formatDateTime(item.recordingTime ?? item.dateTime ?? item.dateCreated),
          uploadedAt,
          videoType: formatOptions[0]?.label ?? 'VGA',
          formatOptions,
          captionSrc: primaryCaption?.src?.trim() ?? null,
          captionLanguage: primaryCaption?.type ?? null,
          captionLabel: primaryCaption?.label ?? null
        } satisfies UiMediaItem;
      });

      return {
        courseDigit,
        courseListId,
        title: buildCourseTitle(title, mediaList, courseDigit),
        media,
        expanded: false
      } satisfies UiCourse;
    },
    []
  );

  const loadInitialState = useCallback(async () => {
    const runId = loadRunRef.current + 1;
    loadRunRef.current = runId;
    setIsLoading(true);
    setErrorMessage('');
    setCourses([]);
    setMediaSizeBytesByKey({});
    setSelectedFormatByKey({});
    mediaSizeFetchInFlightRef.current.clear();

    const invalidateAuthAndShowSetup = async () => {
      await Promise.all([
        storageSet('RecordingsInfo', { stoken: null, etime: null }),
        storageSet('MediaRecordings', {}),
        storageSet('CoursesList', { coursesList: [] }),
        storageSet('Cookies', {})
      ]);
      setAuth(null);
      setAuthReadiness({
        hasStoken: false,
        hasEtime: false,
        hasBearer: false,
        hasCourses: false,
        hasCookies: false
      });
      setCourses([]);
      setErrorMessage('Session token expired or unauthorized. Open myCourses, play a lecture, then click Re-check Setup.');
      setStatusMessage('Re-authentication required.');
      setActiveTab('courses');
    };

    try {
      const [downloadedItems, previousQueue, storedCatalog, storedHidden, readiness, preferences, tutorialSeen] = await Promise.all([
        readDownloadedItems(),
        storageGet('downloadQueueState'),
        storageGet('courseCatalog'),
        storageGet('hiddenCourseDigits'),
        readAuthReadiness(),
        readUiPreferences(),
        storageGet('quickTutorialSeen')
      ]);

      if (runId !== loadRunRef.current) {
        return;
      }

      const defaultPreferences: UiPreferences = {
        performanceMode: false,
        reducedMotion: false,
        showVisualEffects: true,
        menuCollapsed: false,
        remuxToMp4: true
      };
      const loadedPreferences = preferences ?? defaultPreferences;
      setUiPreferences(loadedPreferences);
      if (!tutorialSeen) {
        const authReadyAtStart = isAuthReady(readiness);
        const planStepIds = getTutorialPlan(authReadyAtStart);
        tutorialStepEntryRef.current = null;
        tutorialMenuCollapsedAtStartRef.current = loadedPreferences.menuCollapsed;
        if (loadedPreferences.menuCollapsed) {
          const expandedPreferences: UiPreferences = {
            ...loadedPreferences,
            menuCollapsed: false
          };
          setUiPreferences(expandedPreferences);
          await storageSet('uiPreferences', expandedPreferences);
        }
        setQuickTutorialPlanStepIds(planStepIds);
        setQuickTutorialStepId(planStepIds[0] ?? FIRST_TUTORIAL_STEP_ID);
        setTutorialCompletedStepIds(new Set());
        setTutorialStartedWithAuthReady(authReadyAtStart);
        setShowQuickTutorial(true);
      }
      setDownloaded(downloadedItems);
      setAuthReadiness(readiness);

      const hiddenList = storedHidden?.list ?? [];
      const hiddenSet = new Set(hiddenList);
      setHiddenCourseDigits(hiddenSet);
      setCourseCatalog(storedCatalog?.courses ?? []);

      if (previousQueue?.items?.length) {
        let restoredItems = previousQueue.items.map((item) => hydrateQueueItem(item)).filter((item) => item.status !== 'done');
        if (previousQueue.active) {
          restoredItems = restoredItems.map((item) => {
            if (item.status === 'downloading' || item.status === 'queued') {
              return {
                ...item,
                status: 'canceled',
                error: 'Interrupted when extension UI was closed.'
              } satisfies DownloadQueueItem;
            }
            return item;
          });
          setStatusMessage('Previous queue run was interrupted. Restart queue or run jobs individually.');
          await persistQueue(restoredItems, false, false);
        }

        setQueueItems(restoredItems);
        setActiveDownloadTotal(restoredItems.length);
        setActiveDownloadCompleted(0);
      }

      if (!isAuthReady(readiness)) {
        setAuth(null);
        setCourses([]);
        setIsLoading(false);
        return;
      }

      const authData = await readRequiredAuthData();
      if (runId !== loadRunRef.current) {
        return;
      }
      setAuth(authData);

      const candidateMap = new Map<string, { courseDigit: string; title: string; courseListId: string | null }>();
      const catalogCourses = storedCatalog?.courses ?? [];
      const courseByListId = new Map<string, CourseCatalogEntry>();
      catalogCourses.forEach((entry) => {
        if (entry.courseListId) {
          courseByListId.set(entry.courseListId, entry);
        }
      });

      // Always resolve newly captured courseList IDs so renamed/new courses refresh metadata.
      const resolvableCourseListIds = authData.coursesList.filter((courseListId) => {
        const existing = courseByListId.get(courseListId);
        if (!existing) {
          return true;
        }
        return !hiddenSet.has(existing.courseDigit);
      });
      const resolvedCourses = await mapWithConcurrency(resolvableCourseListIds, 3, async (courseListId) => {
        const resolved = await resolveCourseDigit(authData.cookieHeader, courseListId);
        if (!resolved.courseDigit) {
          return null;
        }
        console.log("Resolved course digit:", resolved.courseDigit, "for course list ID:", courseListId, "with context title:", resolved.contextTitle);
        const title = resolved.contextTitle;
        return {
          courseDigit: resolved.courseDigit,
          title,
          courseListId
        };
      });

      if (runId !== loadRunRef.current) {
        return;
      }

      if (resolvedCourses.some((result) => result.status === 'rejected' && isUnauthorizedError(result.reason))) {
        await invalidateAuthAndShowSetup();
        return;
      }

      resolvedCourses.forEach((result) => {
        if (result.status !== 'fulfilled' || !result.value) {
          return;
        }
        candidateMap.set(result.value.courseDigit, result.value);
      });

      const courseDigits = await storageGet('CoursesDigits');
      for (const courseDigit of courseDigits?.list ?? []) {
        if (hiddenSet.has(courseDigit)) {
          continue;
        }
        if (candidateMap.has(courseDigit)) {
          continue;
        }
        const existingTitle = (storedCatalog?.courses ?? []).find((item) => item.courseDigit === courseDigit)?.title;
        candidateMap.set(courseDigit, {
          courseDigit,
          title: existingTitle ?? `Course ID: ${courseDigit}`,
          courseListId: null
        });
      }

      const currentTime = Date.now();
      const catalogFromLoad: CourseCatalogEntry[] = Array.from(candidateMap.values()).map((course) => ({
        courseDigit: course.courseDigit,
        title: course.title,
        courseListId: course.courseListId,
        lastSeenAt: currentTime
      }));

      const mergedByDigit = new Map((storedCatalog?.courses ?? []).map((entry) => [entry.courseDigit, entry] as const));
      catalogFromLoad.forEach((incoming) => {
        const existing = mergedByDigit.get(incoming.courseDigit);
        if (!existing) {
          mergedByDigit.set(incoming.courseDigit, incoming);
          return;
        }

        const keepExistingTitle = !isFallbackCourseIdTitle(existing.title) && isFallbackCourseIdTitle(incoming.title);
        mergedByDigit.set(incoming.courseDigit, {
          ...existing,
          ...incoming,
          title: keepExistingTitle ? existing.title : incoming.title
        });
      });
      let mergedCatalog = dedupeCourseCatalog(Array.from(mergedByDigit.values()));

      const visibleCandidates = Array.from(candidateMap.values()).filter((course) => !hiddenSet.has(course.courseDigit));
      const courseResults = await mapWithConcurrency(visibleCandidates, 3, async (candidate) =>
        buildCourse(candidate.courseDigit, authData.bearer, candidate.title, candidate.courseListId)
      );

      if (runId !== loadRunRef.current) {
        return;
      }

      if (courseResults.some((result) => result.status === 'rejected' && isUnauthorizedError(result.reason))) {
        await invalidateAuthAndShowSetup();
        return;
      }

      const loadedCourses: UiCourse[] = [];
      for (const result of courseResults) {
        if (result.status !== 'fulfilled' || !result.value) {
          continue;
        }
        loadedCourses.push(result.value);
      }
      loadedCourses.sort((a, b) => a.title.localeCompare(b.title));

      if (loadedCourses.length > 0) {
        const courseByDigit = new Map(mergedCatalog.map((entry) => [entry.courseDigit, entry] as const));
        loadedCourses.forEach((course) => {
          const existing = courseByDigit.get(course.courseDigit);
          if (!existing) {
            courseByDigit.set(course.courseDigit, {
              courseDigit: course.courseDigit,
              title: course.title,
              courseListId: course.courseListId,
              lastSeenAt: Date.now()
            });
            return;
          }

          courseByDigit.set(course.courseDigit, {
            ...existing,
            title: course.title,
            courseListId: course.courseListId ?? existing.courseListId,
            lastSeenAt: Date.now()
          });
        });
        mergedCatalog = dedupeCourseCatalog(Array.from(courseByDigit.values()));
      }

      setCourseCatalog(mergedCatalog);
      await storageSet('courseCatalog', { courses: mergedCatalog });

      setCourses(loadedCourses);
    } catch (error) {
      if (runId !== loadRunRef.current) {
        return;
      }
      if (isUnauthorizedError(error)) {
        await invalidateAuthAndShowSetup();
        return;
      }
      setErrorMessage(toErrorMessage(error));
      setCourses([]);
    } finally {
      if (runId === loadRunRef.current) {
        setIsLoading(false);
      }
    }
  }, [buildCourse, hydrateQueueItem, persistQueue]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    channelRef.current = params.get('channel') ?? '';
    parentOriginRef.current = resolveParentTargetOrigin(params.get('parentOrigin'));
  }, []);

  useEffect(() => {
    void loadInitialState();
  }, [loadInitialState]);

  useEffect(() => {
    if (!auth) {
      return;
    }

    const expandedSelections = courses.flatMap((course) =>
      course.expanded
        ? course.media.map((media) => {
            const formatLabel = selectedFormatByKey[media.key] ?? media.videoType;
            const selectionKey = `${media.key}::${formatLabel}`;
            return { media, formatLabel, selectionKey };
          })
        : []
    );
    const pending = expandedSelections.filter(
      (entry) =>
        mediaSizeBytesByKey[entry.selectionKey] === undefined && !mediaSizeFetchInFlightRef.current.has(entry.selectionKey)
    );

    if (pending.length === 0) {
      return;
    }

    const controller = new AbortController();
    pending.forEach((entry) => {
      mediaSizeFetchInFlightRef.current.add(entry.selectionKey);
    });

    void (async () => {
      const results = await mapWithConcurrency(pending, 4, async (entry) => {
        try {
          const sizeBytes = await detectMediaSizeBytes({
            rid: entry.media.id,
            formatLabel: entry.formatLabel,
            stoken: auth.stoken,
            etime: auth.etime,
            signal: controller.signal
          });
          return { selectionKey: entry.selectionKey, sizeBytes };
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          return { selectionKey: entry.selectionKey, sizeBytes: null };
        }
      });

      if (controller.signal.aborted) {
        return;
      }

      const updates: Record<string, number | null> = {};
      results.forEach((result, index) => {
        const pendingEntry = pending[index];
        mediaSizeFetchInFlightRef.current.delete(pendingEntry.selectionKey);

        if (result.status === 'fulfilled') {
          updates[result.value.selectionKey] = result.value.sizeBytes;
          return;
        }

        if (!isAbortError(result.reason)) {
          updates[pendingEntry.selectionKey] = null;
        }
      });

      if (Object.keys(updates).length > 0) {
        setMediaSizeBytesByKey((previous) => ({
          ...previous,
          ...updates
        }));
      }
    })();

    return () => {
      controller.abort();
      pending.forEach((entry) => {
        mediaSizeFetchInFlightRef.current.delete(entry.selectionKey);
      });
    };
  }, [auth, courses, mediaSizeBytesByKey, selectedFormatByKey]);

  useEffect(() => {
    if (channelRef.current) {
      window.parent.postMessage(
        {
          source: PARENT_MESSAGE_SOURCE,
          type: PARENT_MESSAGE_TYPE_DOWNLOAD_STATE,
          active: isDownloading,
          channel: channelRef.current
        },
        parentOriginRef.current
      );
    }

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDownloading) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [isDownloading]);

  useEffect(() => {
    const powerApi = chrome.power;
    if (!powerApi) {
      return;
    }

    if (isDownloading) {
      if (!keepAwakeRequestedRef.current) {
        try {
          powerApi.requestKeepAwake('display');
          keepAwakeRequestedRef.current = true;
        } catch (error) {
          console.warn('Failed to request keep-awake while downloading', error);
        }
      }
    } else if (keepAwakeRequestedRef.current) {
      try {
        powerApi.releaseKeepAwake();
      } catch (error) {
        console.warn('Failed to release keep-awake', error);
      } finally {
        keepAwakeRequestedRef.current = false;
      }
    }

    return () => {
      if (!keepAwakeRequestedRef.current) {
        return;
      }
      try {
        powerApi.releaseKeepAwake();
      } catch (error) {
        console.warn('Failed to release keep-awake on cleanup', error);
      } finally {
        keepAwakeRequestedRef.current = false;
      }
    };
  }, [isDownloading]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void loadInitialState();
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
      }

      if (event.key === 'Escape' && activeTab === 'guide') {
        setActiveTab('courses');
      }

      if (!isTyping && event.key === ' ' && isDownloading) {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeTab, isDownloading, loadInitialState]);

  const syncUniformActionButtonWidth = useCallback(() => {
    const appShell = appShellRef.current;
    if (!appShell) {
      return;
    }

    // Measure natural button widths first, then lock all action buttons to the widest visible one.
    appShell.style.removeProperty('--uniform-action-button-width');

    const actionButtons = Array.from(appShell.querySelectorAll<HTMLButtonElement>('button.action-button'));
    let widest = 0;

    actionButtons.forEach((button) => {
      if (button.getClientRects().length === 0) {
        return;
      }

      const width = Math.ceil(button.getBoundingClientRect().width);
      if (width > widest) {
        widest = width;
      }
    });

    if (widest > 0) {
      appShell.style.setProperty('--uniform-action-button-width', `${widest}px`);
    }
  }, []);

  useEffect(() => {
    const rafId = window.requestAnimationFrame(syncUniformActionButtonWidth);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  });

  useEffect(() => {
    const onResize = () => {
      syncUniformActionButtonWidth();
    };

    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [syncUniformActionButtonWidth]);

  const toggleCourseExpansion = (courseDigit: string) => {
    setCourses((previous) =>
      previous.map((course) => ({
        ...course,
        expanded: course.courseDigit === courseDigit ? !course.expanded : false
      }))
    );
  };

  const toggleMediaSelection = (key: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleMediaFormatChange = (mediaKey: string, formatLabel: string) => {
    setSelectedFormatByKey((previous) => ({
      ...previous,
      [mediaKey]: formatLabel
    }));
  };

  const setCourseSelection = (course: UiCourse, onlyNotDownloaded: boolean, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      course.media.forEach((item) => {
        if (onlyNotDownloaded && isMediaDownloaded(item)) {
          return;
        }

        if (checked) {
          next.add(item.key);
        } else {
          next.delete(item.key);
        }
      });
      return next;
    });
  };

  const setDownloadedState = async (marker: string, filename: string, value: boolean) => {
    const next = new Set(downloaded);
    const legacyMarker = createLegacyFilenameMarker(filename);

    if (value) {
      next.add(marker);
      next.add(legacyMarker);
    } else {
      next.delete(marker);
      next.delete(filename);
      next.delete(legacyMarker);
    }

    setDownloaded(new Set(next));
    await writeDownloadedItems(next);
  };

  const setCourseVisibility = async (courseDigit: string, visible: boolean) => {
    const nextHidden = new Set(hiddenCourseDigits);
    if (visible) {
      nextHidden.delete(courseDigit);
    } else {
      nextHidden.add(courseDigit);
    }

    setHiddenCourseDigits(nextHidden);
    await storageSet('hiddenCourseDigits', { list: Array.from(nextHidden) });

    if (!visible) {
      setCourses((previous) => previous.filter((course) => course.courseDigit !== courseDigit));
      const mediaKeys = new Set(
        courses.find((course) => course.courseDigit === courseDigit)?.media.map((media) => media.key) ?? []
      );
      if (mediaKeys.size > 0) {
        setSelected((previous) => {
          const next = new Set(previous);
          mediaKeys.forEach((key) => {
            next.delete(key);
          });
          return next;
        });
      }
      return;
    }

    const alreadyLoaded = courses.some((course) => course.courseDigit === courseDigit);
    if (alreadyLoaded || !auth) {
      return;
    }

    const catalogEntry = courseCatalog.find((item) => item.courseDigit === courseDigit);
    try {
      const course = await buildCourse(
        courseDigit,
        auth.bearer,
        catalogEntry?.title,
        catalogEntry?.courseListId ?? null
      );
      if (!course) {
        return;
      }
      setCourses((previous) => {
        if (previous.some((item) => item.courseDigit === course.courseDigit)) {
          return previous;
        }
        const next = [...previous, course];
        next.sort((a, b) => a.title.localeCompare(b.title));
        return next;
      });
    } catch {
      setErrorMessage(`Failed to load ${catalogEntry?.title ?? courseDigit}.`);
    }
  };

  const setAllCourseVisibility = async (visible: boolean) => {
    const nextHidden = visible ? new Set<string>() : new Set(courseCatalog.map((item) => item.courseDigit));
    setHiddenCourseDigits(nextHidden);
    await storageSet('hiddenCourseDigits', { list: Array.from(nextHidden) });
    if (!visible) {
      setCourses([]);
      setSelected(new Set());
      return;
    }
    void loadInitialState();
  };

  const handleSelectAll = () => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (areAllVisibleSelected) {
        allVisibleMediaKeys.forEach((key) => {
          next.delete(key);
        });
        return next;
      }

      allVisibleMediaKeys.forEach((key) => {
        next.add(key);
      });
      return next;
    });
  };

  const handleSelectAllNotDownloaded = () => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (areAllVisibleNotDownloadedSelected) {
        allVisibleNotDownloadedMediaKeys.forEach((key) => {
          next.delete(key);
        });
        return next;
      }

      allVisibleNotDownloadedMediaKeys.forEach((key) => {
        next.add(key);
      });
      return next;
    });
  };

  const handleMarkAllDownloaded = async () => {
    const shouldProceed = await askForConfirmation({
      title: 'Mark All Downloaded?',
      message: 'This marks every visible video as downloaded in the extension tracker.',
      confirmLabel: 'Mark Downloaded',
      variant: 'default'
    });
    if (!shouldProceed) {
      return;
    }

    const next = new Set(downloaded);
    visibleCourses.forEach((course) => {
      course.media.forEach((item) => {
        next.add(item.downloadMarker);
        next.add(createLegacyFilenameMarker(item.filename));
      });
    });

    setDownloaded(new Set(next));
    await writeDownloadedItems(next);
  };

  const updatePreferences = async (patch: Partial<UiPreferences>) => {
    const next = {
      ...uiPreferences,
      ...patch
    };
    setUiPreferences(next);
    await storageSet('uiPreferences', next);
  };

  const askForConfirmation = useCallback(
    (config: Omit<ConfirmDialogState, 'resolve'>): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setConfirmDialog({
          ...config,
          resolve
        });
      }),
    []
  );

  const closeConfirmDialog = useCallback((confirmed: boolean) => {
    setConfirmDialog((current) => {
      if (!current) {
        return null;
      }
      current.resolve(confirmed);
      return null;
    });
  }, []);

  const startQuickTutorial = useCallback(
    (authReadyAtStart: boolean) => {
      const planStepIds = getTutorialPlan(authReadyAtStart);
      tutorialStepEntryRef.current = null;
      tutorialMenuCollapsedAtStartRef.current = isMenuCollapsed;
      if (isMenuCollapsed) {
        void updatePreferences({ menuCollapsed: false });
      }
      setQuickTutorialPlanStepIds(planStepIds);
      setQuickTutorialStepId(planStepIds[0] ?? FIRST_TUTORIAL_STEP_ID);
      setTutorialCompletedStepIds(new Set());
      setTutorialStartedWithAuthReady(authReadyAtStart);
      setShowQuickTutorial(true);
    },
    [isMenuCollapsed, updatePreferences]
  );

  const completeQuickTutorial = useCallback(async () => {
    setShowQuickTutorial(false);
    tutorialTargetRef.current?.classList.remove('tutorial-highlight');
    tutorialTargetRef.current = null;
    tutorialStepEntryRef.current = null;
    setTutorialTargetVisible(false);
    setTutorialCoachStyle({});
    setTutorialPointerStyle({});
    setTutorialSpotlightPanels(null);
    const restoreMenuCollapsed = tutorialMenuCollapsedAtStartRef.current === true;
    tutorialMenuCollapsedAtStartRef.current = null;
    if (restoreMenuCollapsed) {
      await updatePreferences({ menuCollapsed: true });
    }
    await storageSet('quickTutorialSeen', true);
  }, [updatePreferences]);

  const replayQuickTutorial = useCallback(() => {
    startQuickTutorial(authReady);
  }, [authReady, startQuickTutorial]);

  const handleQuickTutorialNext = useCallback(() => {
    if (!tutorialEvaluation.isComplete) {
      return;
    }
    if (isLastTutorialStep) {
      void completeQuickTutorial();
      return;
    }

    const requestedStepId = getNextTutorialStepId(quickTutorialStepId, quickTutorialPlanStepIds);
    setQuickTutorialStepId(requestedStepId);
  }, [completeQuickTutorial, isLastTutorialStep, quickTutorialPlanStepIds, quickTutorialStepId, tutorialEvaluation.isComplete]);

  const handleQuickTutorialBack = useCallback(() => {
    const requestedStepId = getPreviousTutorialStepId(quickTutorialStepId, quickTutorialPlanStepIds);
    setQuickTutorialStepId(requestedStepId);
  }, [quickTutorialPlanStepIds, quickTutorialStepId]);

  useEffect(() => {
    if (!showQuickTutorial) {
      tutorialTargetRef.current?.classList.remove('tutorial-highlight');
      tutorialTargetRef.current = null;
      tutorialStepEntryRef.current = null;
      setTutorialTargetVisible(false);
      setTutorialCoachStyle({});
      setTutorialPointerStyle({});
      setTutorialSpotlightPanels(null);
      return;
    }
  }, [showQuickTutorial]);

  useEffect(() => {
    if (!showQuickTutorial) {
      return;
    }

    if (!currentTutorialStep.targetSelector) {
      tutorialTargetRef.current?.classList.remove('tutorial-highlight');
      tutorialTargetRef.current = null;
      setTutorialTargetVisible(false);
      setTutorialPointerStyle({});
      setTutorialSpotlightPanels(null);
      tutorialStepEntryRef.current = currentTutorialStep.id;
      return;
    }

    const target = document.querySelector<HTMLElement>(currentTutorialStep.targetSelector);
    if (!target) {
      tutorialTargetRef.current?.classList.remove('tutorial-highlight');
      tutorialTargetRef.current = null;
      setTutorialTargetVisible(false);
      setTutorialSpotlightPanels(null);
      return;
    }

    tutorialTargetRef.current?.classList.remove('tutorial-highlight');
    tutorialTargetRef.current = target;
    setTutorialTargetVisible(true);
    target.classList.add('tutorial-highlight');
    if (tutorialStepEntryRef.current !== currentTutorialStep.id) {
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      tutorialStepEntryRef.current = currentTutorialStep.id;
    }

    const placeCoach = () => {
      if (!document.body.contains(target)) {
        return;
      }

      const coachElement = tutorialCoachRef.current;
      if (!coachElement) {
        return;
      }

      const targetRect = target.getBoundingClientRect();
      const coachRect = coachElement.getBoundingClientRect();
      const viewportPadding = 12;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gap = 14;
      const coachWidth = Math.min(coachRect.width, viewportWidth - viewportPadding * 2);
      const coachHeight = Math.min(coachRect.height, viewportHeight - viewportPadding * 2);
      const centerX = targetRect.left + targetRect.width / 2;
      const centerY = targetRect.top + targetRect.height / 2;
      const placements: Array<'bottom' | 'top' | 'right' | 'left'> = ['bottom', 'top', 'right', 'left'];
      type CoachPlacement = 'bottom' | 'top' | 'right' | 'left';
      interface CoachCandidate {
        placement: CoachPlacement;
        left: number;
        top: number;
        priority: number;
      }
      const buildCandidates = (width: number, height: number) => {
        const bounds = {
          minLeft: viewportPadding,
          maxLeft: Math.max(viewportPadding, viewportWidth - width - viewportPadding),
          minTop: viewportPadding,
          maxTop: Math.max(viewportPadding, viewportHeight - height - viewportPadding)
        };
        const directionalCandidates: CoachCandidate[] = placements.map((placement, index) => {
          if (placement === 'bottom') {
            return {
              placement,
              left: clamp(centerX - width / 2, bounds.minLeft, bounds.maxLeft),
              top: targetRect.bottom + gap,
              priority: index
            };
          }
          if (placement === 'top') {
            return {
              placement,
              left: clamp(centerX - width / 2, bounds.minLeft, bounds.maxLeft),
              top: targetRect.top - height - gap,
              priority: index
            };
          }
          if (placement === 'right') {
            return {
              placement,
              left: targetRect.right + gap,
              top: clamp(centerY - height / 2, bounds.minTop, bounds.maxTop),
              priority: index
            };
          }
          return {
            placement,
            left: targetRect.left - width - gap,
            top: clamp(centerY - height / 2, bounds.minTop, bounds.maxTop),
            priority: index
          };
        });

        // Extra corner anchors keep the coach away from center controls on tight layouts.
        const cornerAnchors: Array<{ left: number; top: number }> = [
          { left: bounds.minLeft, top: bounds.minTop },
          { left: bounds.maxLeft, top: bounds.minTop },
          { left: bounds.minLeft, top: bounds.maxTop },
          { left: bounds.maxLeft, top: bounds.maxTop }
        ];

        const cornerCandidates: CoachCandidate[] = cornerAnchors.map((anchor, index) => ({
          placement: anchor.top <= centerY ? 'top' : 'bottom',
          left: anchor.left,
          top: anchor.top,
          priority: placements.length + index
        }));

        return { bounds, candidates: [...directionalCandidates, ...cornerCandidates] };
      };

      const targetRectForOverlap = new DOMRect(targetRect.left, targetRect.top, targetRect.width, targetRect.height);
      const chooseCandidate = (
        width: number,
        height: number,
        candidates: CoachCandidate[]
      ): CoachCandidate | null => {
        const evaluateCandidate = (candidate: CoachCandidate) => {
          const clampedLeft = clamp(candidate.left, viewportPadding, Math.max(viewportPadding, viewportWidth - width - viewportPadding));
          const clampedTop = clamp(candidate.top, viewportPadding, Math.max(viewportPadding, viewportHeight - height - viewportPadding));
          const candidateRect = new DOMRect(clampedLeft, clampedTop, width, height);
          const insideViewport =
            candidateRect.left >= viewportPadding &&
            candidateRect.top >= viewportPadding &&
            candidateRect.right <= viewportWidth - viewportPadding &&
            candidateRect.bottom <= viewportHeight - viewportPadding;

          const overlapX = Math.max(
            0,
            Math.min(candidateRect.right, targetRectForOverlap.right) -
              Math.max(candidateRect.left, targetRectForOverlap.left)
          );
          const overlapY = Math.max(
            0,
            Math.min(candidateRect.bottom, targetRectForOverlap.bottom) -
              Math.max(candidateRect.top, targetRectForOverlap.top)
          );
          const overlapArea = overlapX * overlapY;

          const candidateCenterX = candidateRect.left + candidateRect.width / 2;
          const candidateCenterY = candidateRect.top + candidateRect.height / 2;
          const distanceFromTarget =
            (candidateCenterX - centerX) * (candidateCenterX - centerX) +
            (candidateCenterY - centerY) * (candidateCenterY - centerY);

          return {
            ...candidate,
            left: clampedLeft,
            top: clampedTop,
            insideViewport,
            overlapArea,
            distanceFromTarget
          };
        };

        const evaluated = candidates.map((candidate) => evaluateCandidate(candidate));
        const nonOverlapping = evaluated
          .filter((candidate) => candidate.insideViewport && candidate.overlapArea === 0)
          .sort((a, b) => {
            if (b.distanceFromTarget !== a.distanceFromTarget) {
              return b.distanceFromTarget - a.distanceFromTarget;
            }
            return a.priority - b.priority;
          });

        if (nonOverlapping.length > 0) {
          return nonOverlapping[0];
        }

        const overlapping = evaluated
          .filter((candidate) => candidate.insideViewport)
          .sort((a, b) => {
            if (a.overlapArea !== b.overlapArea) {
              return a.overlapArea - b.overlapArea;
            }
            if (b.distanceFromTarget !== a.distanceFromTarget) {
              return b.distanceFromTarget - a.distanceFromTarget;
            }
            return a.priority - b.priority;
          });

        return overlapping[0] ?? null;
      };

      const primary = buildCandidates(coachWidth, coachHeight);
      let finalCoachWidth = coachWidth;
      let finalCoachHeight = coachHeight;
      let chosenCandidate = chooseCandidate(finalCoachWidth, finalCoachHeight, primary.candidates);

      if (!chosenCandidate) {
        // Compact fallback to reduce overlap risk on tight viewports.
        finalCoachWidth = Math.max(220, Math.min(finalCoachWidth, Math.floor((viewportWidth - viewportPadding * 2) * 0.82)));
        finalCoachHeight = Math.max(180, Math.min(finalCoachHeight, viewportHeight - viewportPadding * 2 - 24));
        const compact = buildCandidates(finalCoachWidth, finalCoachHeight);
        chosenCandidate = chooseCandidate(finalCoachWidth, finalCoachHeight, compact.candidates);
      }

      if (!chosenCandidate) {
        chosenCandidate = {
          placement: 'top',
          left: viewportPadding,
          top: viewportPadding,
          priority: 0
        };
      }

      const pointerStyle: CSSProperties =
        chosenCandidate.placement === 'bottom' || chosenCandidate.placement === 'top'
          ? {
              left: `${clamp(centerX - chosenCandidate.left, 16, finalCoachWidth - 16)}px`
            }
          : {
              top: `${clamp(centerY - chosenCandidate.top, 16, finalCoachHeight - 16)}px`
            };

      setTutorialCoachPlacement(chosenCandidate.placement);
      setTutorialCoachStyle({
        left: `${chosenCandidate.left}px`,
        top: `${chosenCandidate.top}px`,
        width: `${finalCoachWidth}px`,
        maxHeight: `${Math.max(180, viewportHeight - viewportPadding * 2)}px`
      });
      setTutorialPointerStyle(pointerStyle);
      setTutorialSpotlightPanels(
        buildTutorialSpotlightPanels(
          {
            left: targetRect.left,
            top: targetRect.top,
            width: targetRect.width,
            height: targetRect.height
          },
          { width: viewportWidth, height: viewportHeight },
          { padding: 8 }
        )
      );
    };

    const scheduleReposition = () => {
      if (tutorialPositionRafRef.current !== null) {
        return;
      }
      tutorialPositionRafRef.current = window.requestAnimationFrame(() => {
        tutorialPositionRafRef.current = null;
        placeCoach();
      });
    };

    scheduleReposition();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        scheduleReposition();
      });
      observer.observe(target);
      if (tutorialCoachRef.current) {
        observer.observe(tutorialCoachRef.current);
      }
    }

    window.addEventListener('resize', scheduleReposition);
    window.addEventListener('scroll', scheduleReposition, true);

    return () => {
      window.removeEventListener('resize', scheduleReposition);
      window.removeEventListener('scroll', scheduleReposition, true);
      observer?.disconnect();
      if (tutorialPositionRafRef.current !== null) {
        window.cancelAnimationFrame(tutorialPositionRafRef.current);
        tutorialPositionRafRef.current = null;
      }
      target.classList.remove('tutorial-highlight');
      if (tutorialTargetRef.current === target) {
        tutorialTargetRef.current = null;
      }
    };
  }, [activeTab, authReady, currentTutorialStep.id, currentTutorialStep.targetSelector, isMenuCollapsed, showCourseActions, showQuickTutorial]);

  useEffect(() => {
    if (!showQuickTutorial || !currentTutorialStep.targetSelector) {
      return;
    }

    const selector = currentTutorialStep.targetSelector;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest(selector)) {
        return;
      }

      window.setTimeout(() => {
        setTutorialCompletedStepIds((previous) => {
          const next = new Set(previous);
          next.add(currentTutorialStep.id);
          return next;
        });
      }, 0);
    };

    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
    };
  }, [currentTutorialStep.id, currentTutorialStep.targetSelector, showQuickTutorial]);

  const runQueue = useCallback(
    async (initialItems: DownloadQueueItem[], options?: { onlyKeys?: Set<string> }) => {
      if (!auth) {
        setErrorMessage('Missing auth/session data. Open myCourses and play a lecture, then refresh courses.');
        return;
      }

      const workingItems: DownloadQueueItem[] = initialItems.map((item) => ({ ...item }));
      const targetKeys =
        options?.onlyKeys ??
        new Set(workingItems.filter((item) => item.status === 'queued').map((item) => item.key));

      if (targetKeys.size === 0) {
        setQueueItems(workingItems);
        await persistQueue(workingItems, false, false);
        return;
      }

      setErrorMessage('');
      setIsDownloading(true);
      stopRequestedRef.current = false;
      cancelRequestedKeysRef.current.clear();
      setQueueItems(workingItems);
      setActiveDownloadTotal(targetKeys.size);
      setActiveDownloadCompleted(0);
      setActiveTab('queue');
      await persistQueue(workingItems, true, false);

      abortControllerRef.current = new AbortController();
      const localDownloaded = new Set(downloaded);
      const failures: string[] = [];
      let stopped = false;
      let startedCount = 0;

      const applyPendingCancels = () => {
        let hasChanges = false;

        for (let pendingIndex = 0; pendingIndex < workingItems.length; pendingIndex += 1) {
          const pendingItem = workingItems[pendingIndex];
          if (!targetKeys.has(pendingItem.key) || pendingItem.status !== 'queued') {
            continue;
          }

          if (cancelRequestedKeysRef.current.has(pendingItem.key)) {
            cancelRequestedKeysRef.current.delete(pendingItem.key);
            workingItems[pendingIndex] = {
              ...pendingItem,
              status: 'canceled',
              error: 'Canceled by user.'
            };
            hasChanges = true;
          }
        }

        return hasChanges;
      };

      for (let index = 0; index < workingItems.length; index += 1) {
        if (applyPendingCancels()) {
          setQueueItems([...workingItems]);
          await persistQueue(workingItems, true, false);
        }

        const current = workingItems[index];

        if (!targetKeys.has(current.key) || current.status !== 'queued') {
          continue;
        }

        if (stopRequestedRef.current) {
          stopped = true;
          for (let j = index; j < workingItems.length; j += 1) {
            if (
              targetKeys.has(workingItems[j].key) &&
              (workingItems[j].status === 'queued' || workingItems[j].status === 'downloading')
            ) {
              workingItems[j] = { ...workingItems[j], status: 'canceled', error: 'Canceled by user.' };
            }
          }
          setQueueItems([...workingItems]);
          await persistQueue(workingItems, false, false);
          break;
        }

        if (cancelRequestedKeysRef.current.has(current.key)) {
          cancelRequestedKeysRef.current.delete(current.key);
          workingItems[index] = { ...current, status: 'canceled', error: 'Canceled by user.' };
          setQueueItems([...workingItems]);
          await persistQueue(workingItems, true, false);
          continue;
        }

        startedCount += 1;
        workingItems[index] = { ...current, status: 'downloading', error: undefined };
        setQueueItems([...workingItems]);
        await persistQueue(workingItems, true, false);
        if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) {
          abortControllerRef.current = new AbortController();
        }

        setStatusMessage(`Downloading ${startedCount}/${targetKeys.size}: ${current.recordingName}`);

        try {
          await downloadAndRemuxMedia({
            rid: current.rid,
            fileName: current.fileName,
            formatLabel: current.videoType,
            stoken: auth.stoken,
            etime: auth.etime,
            remuxToMp4: current.remuxToMp4 ?? true,
            bearerToken: auth.bearer,
            captionSrc: current.captionSrc,
            captionLanguage: current.captionLanguage,
            embedCaptions: current.embedCaptions && (current.remuxToMp4 ?? true),
            signal: abortControllerRef.current.signal,
            onProgress: (stage) => {
              setStatusMessage(`${stage} (${startedCount}/${targetKeys.size})`);
            }
          });

          localDownloaded.add(current.downloadMarker);
          localDownloaded.add(createLegacyFilenameMarker(current.fileName));
          setDownloaded(new Set(localDownloaded));
          await writeDownloadedItems(localDownloaded);

          setActiveDownloadCompleted((prev) => prev + 1);
          workingItems.splice(index, 1);
          setQueueItems([...workingItems]);
          await persistQueue(workingItems, true, false);
          index -= 1;
          continue;
        } catch (error) {
          if (isAbortError(error)) {
            if (stopRequestedRef.current || cancelRequestedKeysRef.current.has(current.key)) {
              cancelRequestedKeysRef.current.delete(current.key);
              workingItems[index] = { ...workingItems[index], status: 'canceled', error: 'Canceled by user.' };
              if (stopRequestedRef.current) {
                stopped = true;
                for (let j = index + 1; j < workingItems.length; j += 1) {
                  if (targetKeys.has(workingItems[j].key) && workingItems[j].status === 'queued') {
                    workingItems[j] = { ...workingItems[j], status: 'canceled', error: 'Canceled by user.' };
                  }
                }
                setQueueItems([...workingItems]);
                await persistQueue(workingItems, false, false);
                break;
              }
            } else {
              const err = 'Download was aborted unexpectedly.';
              workingItems[index] = { ...workingItems[index], status: 'failed', error: err };
              failures.push(`${current.fileName}: ${err}`);
            }
            setQueueItems([...workingItems]);
            await persistQueue(workingItems, true, false);
            continue;
          }

          const err = toErrorMessage(error);
          workingItems[index] = { ...workingItems[index], status: 'failed', error: err };
          failures.push(`${current.fileName}: ${err}`);
        }

        setQueueItems([...workingItems]);
        await persistQueue(workingItems, true, false);
      }

      abortControllerRef.current = null;
      stopRequestedRef.current = false;
      cancelRequestedKeysRef.current.clear();
      setIsDownloading(false);

      const canceledCount = workingItems.filter(
        (item) => targetKeys.has(item.key) && item.status === 'canceled'
      ).length;
      if (stopped) {
        setStatusMessage('Queue stopped by user.');
      } else if (failures.length > 0) {
        setStatusMessage(`Queue finished with ${failures.length} failed job${failures.length === 1 ? '' : 's'}.`);
      } else if (canceledCount > 0) {
        setStatusMessage(`Queue finished with ${canceledCount} canceled job${canceledCount === 1 ? '' : 's'}.`);
      } else {
        setStatusMessage('Queue completed.');
      }

      setQueueItems([...workingItems]);
      await persistQueue(workingItems, false, false);

      if (failures.length > 0) {
        setErrorMessage(`Some downloads failed:\n${failures.join('\n')}`);
      }
    },
    [auth, downloaded, persistQueue]
  );

  const handleDownload = async () => {
    const chosen = Array.from(selected)
      .map((key) => mediaByKey.get(key))
      .filter((item): item is UiMediaItem => Boolean(item));

    if (chosen.length === 0) {
      setErrorMessage('Select at least one video to add to queue.');
      return;
    }

    const candidates = chosen.map(
      (item) => {
        const selectedFormat = selectedFormatByKey[item.key] ?? item.videoType;
        return {
          key: item.key,
          courseDigit: item.courseDigit,
          rid: item.id,
          downloadMarker: item.downloadMarker,
          fileName: item.filename,
          videoType: selectedFormat,
          remuxToMp4: uiPreferences.remuxToMp4,
          captionSrc: item.captionSrc,
          captionLanguage: item.captionLanguage,
          embedCaptions: embedCaptions && uiPreferences.remuxToMp4,
          recordingName: item.recordingName,
          status: 'queued'
        } satisfies DownloadQueueItem;
      }
    );

    const byKey = new Map(queueItems.map((item) => [item.key, item] as const));
    let addedCount = 0;

    candidates.forEach((candidate) => {
      const existing = byKey.get(candidate.key);
      if (!existing) {
        byKey.set(candidate.key, candidate);
        addedCount += 1;
        return;
      }

      if (existing.status === 'done' || existing.status === 'failed' || existing.status === 'canceled') {
        byKey.set(candidate.key, { ...candidate, status: 'queued', error: undefined });
        addedCount += 1;
      }
    });

    const nextQueue = Array.from(byKey.values());
    setQueueItems(nextQueue);
    setActiveDownloadTotal(nextQueue.length);
    setActiveDownloadCompleted(nextQueue.filter((item) => item.status === 'done').length);
    await persistQueue(nextQueue, isDownloading, false);
    setStatusMessage(addedCount > 0 ? `${addedCount} item${addedCount === 1 ? '' : 's'} added to queue.` : 'Items are already in queue.');
    setActiveTab('queue');
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  const handleStartQueue = async () => {
    if (isDownloading || queueItems.length === 0) {
      return;
    }

    const preparedQueue = queueItems.map((item) => {
      if (item.status === 'failed' || item.status === 'canceled') {
        return { ...item, status: 'queued', error: undefined };
      }
      return item;
    });

    if (!preparedQueue.some((item) => item.status === 'queued')) {
      setStatusMessage('No queued jobs to start.');
      return;
    }

    setQueueItems(preparedQueue);
    await persistQueue(preparedQueue, false, false);
    await runQueue(preparedQueue);
  };

  const handleStartItem = async (item: DownloadQueueItem) => {
    if (isDownloading || item.status === 'downloading') {
      return;
    }

    const preparedQueue = queueItems.map((entry) => {
      if (entry.key === item.key) {
        return { ...entry, status: 'queued', error: undefined };
      }
      return entry;
    });

    setQueueItems(preparedQueue);
    await persistQueue(preparedQueue, false, false);
    await runQueue(preparedQueue, { onlyKeys: new Set([item.key]) });
  };

  const handleStopDownloading = async () => {
    if (!isDownloading) {
      return;
    }

    const shouldStop = await askForConfirmation({
      title: 'Stop Downloads?',
      message: 'Current and remaining queued downloads in this run will be canceled.',
      confirmLabel: 'Stop Downloads',
      variant: 'danger'
    });
    if (!shouldStop) {
      return;
    }

    stopRequestedRef.current = true;
    cancelRequestedKeysRef.current.clear();
    abortControllerRef.current?.abort();
  };

  const handleCancelItem = (item: DownloadQueueItem) => {
    if (item.status !== 'downloading') {
      return;
    }

    if (!isDownloading) {
      return;
    }

    cancelRequestedKeysRef.current.add(item.key);
    abortControllerRef.current?.abort();
    setStatusMessage(`Canceling: ${item.recordingName}`);
  };

  const handleClearQueue = async () => {
    if (isDownloading || queueItems.length === 0) {
      return;
    }

    const shouldClear = await askForConfirmation({
      title: 'Clear Queue?',
      message: 'This removes all jobs from the queue list. Downloaded files are not deleted.',
      confirmLabel: 'Clear Queue',
      variant: 'danger'
    });
    if (!shouldClear) {
      return;
    }

    setQueueItems([]);
    setActiveDownloadTotal(0);
    setActiveDownloadCompleted(0);
    setStatusMessage('Queue cleared.');
    await persistQueue([], false, false);
  };

  const handleRemoveItem = async (item: DownloadQueueItem) => {
    if (isDownloading) {
      return;
    }

    const nextQueue = queueItems.filter((entry) => entry.key !== item.key);
    setQueueItems(nextQueue);
    setActiveDownloadTotal(nextQueue.length);
    setActiveDownloadCompleted(nextQueue.filter((entry) => entry.status === 'done').length);
    await persistQueue(nextQueue, false, false);
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const directionKeys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!directionKeys.includes(event.key)) {
      return;
    }

    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    if (tabs.length === 0) {
      return;
    }

    const currentIndex = tabs.findIndex((tab) => tab === document.activeElement);
    let nextIndex = currentIndex >= 0 ? currentIndex : TAB_ORDER.indexOf(activeTab);

    if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = tabs.length - 1;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (nextIndex + 1) % tabs.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (nextIndex - 1 + tabs.length) % tabs.length;
    }

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    nextTab.focus();
    nextTab.click();
  };

  return (
    <main ref={appShellRef} className={`app-shell fade-in ${uiPreferences.reducedMotion ? 'reduce-motion' : ''}`}>
      {!uiPreferences.performanceMode && uiPreferences.showVisualEffects && (
        <Suspense fallback={null}>
          <MouseEffectBackground />
        </Suspense>
      )}

      <section className={`workspace ${isMenuCollapsed ? 'menu-collapsed' : ''}`}>
        <aside className={`menu-shell ${isMenuCollapsed ? 'collapsed' : ''}`} aria-label="Tab menu">
          <button
            type="button"
            className={`menu-toggle ${isMenuCollapsed ? 'handle' : ''}`}
            onClick={() => void updatePreferences({ menuCollapsed: !isMenuCollapsed })}
            aria-label={isMenuCollapsed ? 'Expand menu' : 'Collapse menu'}
            title={isMenuCollapsed ? 'Expand menu' : 'Collapse menu'}
          >
            {isMenuCollapsed ? <img src={logoUrl} alt="McLecture" className="menu-logo-image" /> : <span>Hide</span>}
          </button>

          {!isMenuCollapsed && (
            <>
              <p className="menu-label">Navigation</p>
              <nav
                className="menu-bar"
                aria-label="Primary menu tabs"
                role="tablist"
                aria-orientation="vertical"
                onKeyDown={handleTabKeyDown}
              >
                {TAB_ORDER.map((tab) => (
                  <button
                    key={tab}
                    id={`tab-${tab}`}
                    data-tutorial-id={`tab-${tab}`}
                    type="button"
                    role="tab"
                    tabIndex={activeTab === tab ? 0 : -1}
                    aria-selected={activeTab === tab}
                    aria-controls={`panel-${tab}`}
                    className={`menu-button ${activeTab === tab ? 'active' : ''}`}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === 'courses' ? 'Courses' : tab === 'library' ? 'Library' : tab === 'queue' ? 'Queue' : 'Guide'}
                  </button>
                ))}
              </nav>
            </>
          )}
        </aside>

        <section className="content-column">
          <header className="top-bar">
            <p className="brand">McLecture</p>
            <p className="header-meta">
              {filteredCourses.length} visible / {courseCatalog.length || courses.length} saved
            </p>
          </header>

          {(isLoading || isDownloading) && (
            <section className="progress-shell smooth-enter" aria-live="polite">
              <div className="spinner" />
              <p>
                {isDownloading ? `${statusMessage || 'Downloading...'} ${activeDownloadCompleted}/${activeDownloadTotal}` : 'Loading courses...'}
              </p>
              <div className="progress-determinate" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}>
                <span style={{ width: `${progressPercent}%` }} />
              </div>
            </section>
          )}

          {errorMessage && <pre className="error-banner smooth-enter">{errorMessage}</pre>}

          {activeTab === 'courses' && (
            <section className="panel smooth-enter" id="panel-courses" role="tabpanel" aria-labelledby="tab-courses" tabIndex={0}>
              {!authReady && !isLoading ? (
                <section className="onboarding-panel smooth-enter">
                  <h2>Setup Required</h2>
                  <p>Complete these steps on myCourses before refreshing courses:</p>
                  <ol>
                    <li className={authReadiness?.hasCookies ? 'done' : ''}>Open and log in to myCourses.</li>
                    <li className={authReadiness?.hasCourses ? 'done' : ''}>Open one course page with lecture recordings.</li>
                    <li className={authReadiness?.hasBearer ? 'done' : ''}>Play one lecture to capture API authorization.</li>
                    <li className={authReadiness?.hasStoken && authReadiness?.hasEtime ? 'done' : ''}>
                      Let the lecture load so stream tokens are captured.
                    </li>
                  </ol>
                  <div className="bulk-actions">
                    <button
                      type="button"
                      className="action-button"
                      data-tutorial-id="recheck-setup"
                      onClick={() => void loadInitialState()}
                    >
                      Re-check Setup
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      data-tutorial-id="open-mycourses"
                      onClick={() => window.open('https://mycourses2.mcgill.ca', '_blank', 'noopener,noreferrer')}
                    >
                      Open myCourses
                    </button>
                  </div>
                </section>
              ) : (
                <>
                  <section className="panel-toolbar">
                    <h2>Courses</h2>
                    <button
                      type="button"
                      className="action-button"
                      data-tutorial-id="course-actions-toggle"
                      onClick={() => setShowCourseActions((prev) => !prev)}
                    >
                      {showCourseActions ? 'Hide Actions' : 'Course Actions'}
                    </button>
                  </section>

                  {showCourseActions && (
                    <section className="bulk-actions smooth-enter">
                      <button type="button" className="action-button" onClick={() => void loadInitialState()}>
                        Refresh Courses
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        data-tutorial-id="open-mycourses"
                        onClick={() => window.open('https://mycourses2.mcgill.ca', '_blank', 'noopener,noreferrer')}
                      >
                        Open myCourses
                      </button>
                      <button
                        type="button"
                        className="action-button"
                        data-tutorial-id="recheck-setup"
                        onClick={() => void loadInitialState()}
                      >
                        Re-check Setup
                      </button>
                      <button type="button" className="action-button" onClick={handleSelectAll} disabled={isDownloading}>
                        {areAllVisibleSelected ? 'Unselect All' : 'Select All'}
                      </button>
                      <button
                        type="button"
                        className="action-button"
                        data-tutorial-id="select-all-not-downloaded"
                        onClick={handleSelectAllNotDownloaded}
                        disabled={isDownloading}
                      >
                        {areAllVisibleNotDownloadedSelected
                          ? 'Unselect All Non-Downloaded'
                          : 'Select All Non-Downloaded'}
                      </button>
                      <button type="button" className="action-button" onClick={() => void handleMarkAllDownloaded()}>
                        Mark All Downloaded
                      </button>
                      <label className="inline-toggle">
                        <input
                          type="checkbox"
                          checked={embedCaptions}
                          onChange={(event) => setEmbedCaptions(event.target.checked)}
                          disabled={!uiPreferences.remuxToMp4}
                        />
                        Embed captions into MP4 (when available)
                      </label>
                    </section>
                  )}

                  <div className="search-row">
                    <input
                      ref={searchInputRef}
                      aria-label="Search courses and recordings"
                      placeholder="Search courses, recordings, filenames..."
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                    />
                    <span>{filteredCourses.length} shown</span>
                  </div>

                  <section className="course-list">
                    {isLoading ? (
                      <div className="skeleton-list">
                        <div className="skeleton-item" />
                        <div className="skeleton-item" />
                        <div className="skeleton-item" />
                      </div>
                    ) : null}

                    {!isLoading && filteredCourses.length === 0 && (
                      <p className="empty-state">No matching visible courses. Refresh or adjust your search/filter.</p>
                    )}

                    {filteredCourses.map((course) => {
                      const selectedCount = course.media.filter((item) => selected.has(item.key)).length;
                      const notDownloadedCount = course.media.filter((item) => !isMediaDownloaded(item)).length;
                      const allSelected = selectedCount === course.media.length && course.media.length > 0;
                      const notDownloadedSelected =
                        notDownloadedCount > 0 && course.media.filter((item) => !isMediaDownloaded(item)).every((item) => selected.has(item.key));

                      return (
                        <article key={course.courseDigit} className="course-card smooth-enter">
                          <div className="course-header">
                            <button
                              type="button"
                              className="course-title"
                              onClick={() => toggleCourseExpansion(course.courseDigit)}
                              aria-expanded={course.expanded}
                            >
                              <span>{course.title}</span>
                              <span className={`chevron ${course.expanded ? 'open' : ''}`}>▾</span>
                            </button>
                          </div>

                          {course.expanded && (
                            <div className="course-body smooth-enter">
                              <div className="select-row">
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={allSelected}
                                    onChange={(event) => setCourseSelection(course, false, event.target.checked)}
                                  />
                                  Select All
                                </label>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={notDownloadedSelected}
                                    onChange={(event) => setCourseSelection(course, true, event.target.checked)}
                                  />
                                  Select Not Downloaded
                                </label>
                              </div>

                              <div className="media-list">
                                {course.media.map((media) => {
                                  const itemDownloaded = isMediaDownloaded(media);
                                  const selectedFormat = selectedFormatByKey[media.key] ?? media.videoType;
                                  const selectedFormatDetails = media.formatOptions.find((option) => option.label === selectedFormat);
                                  const sizeLookupKey = `${media.key}::${selectedFormat}`;
                                  return (
                                    <div className={`media-item ${itemDownloaded ? 'downloaded' : ''}`} key={media.key}>
                                      <div className="media-text">
                                        <p className="media-meta">
                                          <span className="field-label">Title:</span> {media.recordingName}
                                        </p>
                                        <p className="media-meta">
                                          <span className="field-label">Recorded At:</span> {media.recordingTime}
                                        </p>
                                        <p className="media-meta">
                                          <span className="field-label">Uploaded At:</span> {formatDateTime(media.uploadedAt)}
                                        </p>
                                        <p className="media-meta">
                                          <span className="field-label">Download Type:</span>{' '}
                                          {selectedFormatDetails?.resolution
                                            ? `${selectedFormat} (${selectedFormatDetails.resolution}p)`
                                            : selectedFormat}
                                        </p>
                                        <p className="media-meta">
                                          <span className="field-label">Captions:</span>{' '}
                                          {media.captionSrc
                                            ? `${media.captionLabel ?? media.captionLanguage ?? 'Available'}${
                                                embedCaptions && uiPreferences.remuxToMp4 ? ' (will embed)' : ' (embedding off)'
                                              }`
                                            : 'Not available'}
                                        </p>
                                        <p className="media-meta">
                                          <span className="field-label">File Size:</span>{' '}
                                          {mediaSizeBytesByKey[sizeLookupKey] === undefined
                                            ? 'Detecting...'
                                            : formatBytes(mediaSizeBytesByKey[sizeLookupKey])}
                                        </p>
                                        <p className="filename">
                                          <span className="field-label">Filename:</span> {media.filename}.mp4
                                        </p>
                                        <div className="media-actions">
                                          <button
                                            type="button"
                                            className="mark-button"
                                            onClick={() => void setDownloadedState(media.downloadMarker, media.filename, !itemDownloaded)}
                                          >
                                            {itemDownloaded ? 'Mark Not Downloaded' : 'Mark Downloaded'}
                                          </button>
                                        </div>
                                      </div>

                                      <div className="media-select">
                                        <label className="format-select">
                                          <span>Download Type</span>
                                          <select
                                            value={selectedFormat}
                                            onChange={(event) => handleMediaFormatChange(media.key, event.target.value)}
                                            disabled={isDownloading}
                                          >
                                            {media.formatOptions.map((option) => (
                                              <option key={option.label} value={option.label}>
                                                {option.resolution ? `${option.label} (${option.resolution}p)` : option.label}
                                              </option>
                                            ))}
                                          </select>
                                        </label>
                                        <label>
                                          <input
                                            type="checkbox"
                                            checked={selected.has(media.key)}
                                            onChange={() => toggleMediaSelection(media.key)}
                                            disabled={isDownloading}
                                          />
                                          Select for Download
                                        </label>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </section>
                </>
              )}
            </section>
          )}

          {activeTab === 'library' && (
            <section className="panel smooth-enter" id="panel-library" role="tabpanel" aria-labelledby="tab-library" tabIndex={0}>
              <section className="panel-toolbar">
                <h2>Course Library</h2>
              </section>
              <section className="visibility-manager smooth-enter">
                <header>
                  <h3>Saved Courses</h3>
                  <p>Toggle whether a course appears in the Courses tab. Hidden courses are not loaded.</p>
                </header>
                <div className="visibility-actions">
                  <button type="button" className="secondary-button" onClick={() => void setAllCourseVisibility(true)}>
                    Show All
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void setAllCourseVisibility(false)}>
                    Hide All
                  </button>
                </div>
                {courseCatalog.length === 0 ? (
                  <p className="empty-state">No saved courses yet. Refresh after playing lectures on myCourses.</p>
                ) : (
                  <ul className="visibility-list">
                    {courseCatalog.map((item) => {
                      const visible = !hiddenCourseDigits.has(item.courseDigit);
                      return (
                        <li key={item.courseDigit}>
                          <label>
                            <input
                              type="checkbox"
                              checked={visible}
                              onChange={(event) => void setCourseVisibility(item.courseDigit, event.target.checked)}
                            />
                            <span>{item.title}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </section>
          )}

          {activeTab === 'queue' && (
            <section className="panel smooth-enter" id="panel-queue" role="tabpanel" aria-labelledby="tab-queue" tabIndex={0}>
              <section className="panel-toolbar">
                <h2>Download Queue</h2>
              </section>

              <section className="queue-summary-grid smooth-enter">
                <article className="queue-stat-card">
                  <p>Total</p>
                  <strong>{queueStats.total}</strong>
                </article>
                <article className="queue-stat-card">
                  <p>Running</p>
                  <strong>{queueStats.downloading}</strong>
                </article>
                <article className="queue-stat-card">
                  <p>Failed</p>
                  <strong>{queueStats.failed}</strong>
                </article>
                <article className="queue-stat-card">
                  <p>Canceled</p>
                  <strong>{queueStats.canceled}</strong>
                </article>
              </section>

              <section className="queue-controls smooth-enter">
                <button
                  type="button"
                  className="action-button"
                  data-tutorial-id="start-queue"
                  onClick={() => void handleStartQueue()}
                  disabled={isDownloading || !hasRunnableQueueItems}
                >
                  Start Queue
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => void handleStopDownloading()}
                  disabled={!isDownloading}
                >
                  Stop Queue
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => void handleClearQueue()}
                  disabled={isDownloading || queueItems.length === 0}
                  data-tutorial-id="clear-queue"
                >
                  Clear Queue
                </button>
              </section>

              {queueItems.length > 0 ? (
                <section className="queue-panel">
                  <h3>Jobs</h3>
                  <ul>
                    {queueItems.map((item) => {
                      const canStart = !isDownloading && item.status !== 'downloading';
                      const canCancel = isDownloading && item.status === 'downloading';
                      const startLabel =
                        item.status === 'done' ? 'Run Again' : item.status === 'queued' ? 'Start Job' : item.status === 'downloading' ? 'Running' : 'Retry';

                      return (
                        <li key={item.key} className={`queue-item status-${item.status}`}>
                          <div className="queue-item-main">
                            <div className="queue-item-header">
                              <strong>{item.recordingName}</strong>
                              <span className={`queue-status-badge status-${item.status}`}>{statusLabel(item.status)}</span>
                            </div>
                            <p className="queue-meta">
                              {item.fileName}.mp4 | {item.videoType}
                              {item.embedCaptions ? ' | captions on' : ''}
                            </p>
                            {item.error && <p className="queue-error">{item.error}</p>}
                          </div>
                          <div className="queue-item-controls">
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => void handleStartItem(item)}
                              disabled={!canStart}
                            >
                              {startLabel}
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => void handleCancelItem(item)}
                              disabled={!canCancel}
                            >
                              Cancel Now
                            </button>
                            <button
                              type="button"
                              className="danger-button"
                              onClick={() => void handleRemoveItem(item)}
                              disabled={isDownloading}
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : (
                <p className="empty-state">Queue is empty. Select videos in Courses and click Add Selected To Queue.</p>
              )}
            </section>
          )}

          {activeTab === 'guide' && (
            <section className="help-panel smooth-enter" id="panel-guide" role="tabpanel" aria-labelledby="tab-guide" tabIndex={0}>
              <h2>Usage Guide</h2>
              <div className="bulk-actions">
                <button type="button" className="action-button" onClick={replayQuickTutorial}>
                  Replay Tutorial
                </button>
              </div>
              <ol>
                <li>Open myCourses, log in, and play one lecture video.</li>
                <li>Go to Courses tab and click Refresh Courses.</li>
                <li>Select recordings and click Add Selected To Queue.</li>
                <li>Use Queue tab controls to start, stop, restart, and manage jobs individually.</li>
                <li>Use Course Library tab to hide courses you do not want loaded.</li>
                <li>Keep this tab open while downloading.</li>
              </ol>

              <section className="permissions-panel">
                <h3>Permissions and Privacy</h3>
                <ul>
                  <li>The overlay can be opened on any normal webpage where Chrome allows script injection.</li>
                  <li>Captured session headers stay in local browser extension storage.</li>
                  <li>No remote analytics or third-party data sharing is performed.</li>
                </ul>
              </section>

              <section className="preferences-panel">
                <h3>Preferences</h3>
                <label>
                  <input
                    type="checkbox"
                    checked={uiPreferences.performanceMode}
                    onChange={(event) => void updatePreferences({ performanceMode: event.target.checked })}
                  />
                  Performance mode (reduce visual effects)
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={uiPreferences.showVisualEffects}
                    onChange={(event) => void updatePreferences({ showVisualEffects: event.target.checked })}
                    disabled={uiPreferences.performanceMode}
                  />
                  Show animated background
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={uiPreferences.reducedMotion}
                    onChange={(event) => void updatePreferences({ reducedMotion: event.target.checked })}
                  />
                  Reduced motion
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={uiPreferences.remuxToMp4}
                    onChange={(event) => void updatePreferences({ remuxToMp4: event.target.checked })}
                  />
                  Transform downloads to MP4 (off = keep original .ts stream)
                </label>
              </section>
            </section>
          )}
        </section>
      </section>

      {showQuickTutorial && tutorialSpotlightPanels && (
        <div
          className={`tutorial-spotlight ${tutorialUseBlurSpotlight ? 'tutorial-spotlight-blur' : 'tutorial-spotlight-dim'}`}
          aria-hidden="true"
        >
          <span className="tutorial-spotlight-panel" style={toFixedRectStyle(tutorialSpotlightPanels.top)} />
          <span className="tutorial-spotlight-panel" style={toFixedRectStyle(tutorialSpotlightPanels.right)} />
          <span className="tutorial-spotlight-panel" style={toFixedRectStyle(tutorialSpotlightPanels.bottom)} />
          <span className="tutorial-spotlight-panel" style={toFixedRectStyle(tutorialSpotlightPanels.left)} />
        </div>
      )}

      {showQuickTutorial && (
        <aside
          ref={tutorialCoachRef}
          className={`tutorial-coach tutorial-coach-${tutorialCoachPlacement}`}
          style={tutorialCoachStyle}
          role="dialog"
          aria-live="polite"
          aria-labelledby="tutorial-title"
        >
          <p className="tutorial-kicker">Guided Tutorial</p>
          <h2 id="tutorial-title">{currentTutorialStep.title}</h2>
          <p>{currentTutorialStep.body}</p>
          {showSetupReadyNote && <p className="tutorial-note">Setup already looks complete, so setup capture steps were skipped.</p>}
          <p className="tutorial-target-hint">
            {tutorialTargetVisible
              ? `Do this now: ${currentTutorialStep.targetHint ?? 'Click the highlighted control.'}`
              : tutorialEvaluation.requiresTargetClick
                ? 'Target is not visible in the current UI state yet.'
                : currentTutorialStep.targetHint ?? 'Complete the step requirements, then continue.'}
          </p>
          {!tutorialEvaluation.isComplete && tutorialEvaluation.blockerMessage && (
            <p className="tutorial-blocker">{tutorialEvaluation.blockerMessage}</p>
          )}
          <p className="tutorial-progress">
            Step {tutorialProgress.current} of {tutorialProgress.total}
          </p>
          <div className="tutorial-actions">
            <button type="button" className="secondary-button" onClick={() => void completeQuickTutorial()}>
              Skip
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={handleQuickTutorialBack}
              disabled={tutorialProgress.current === 1}
              aria-label="Previous step"
              title="Previous step"
            >
              Previous 
            </button>
            {isLastTutorialStep ? (
              <button type="button" className="action-button" onClick={() => void completeQuickTutorial()}>
                Finish
              </button>
            ) : (
              <button type="button" className="action-button" onClick={handleQuickTutorialNext} disabled={!tutorialEvaluation.isComplete}>
                Continue
              </button>
            )}
          </div>
          <span className={`tutorial-pointer tutorial-pointer-${tutorialCoachPlacement}`} style={tutorialPointerStyle} aria-hidden="true" />
        </aside>
      )}

      {confirmDialog && (
        <section className="confirm-backdrop" role="presentation" onClick={() => closeConfirmDialog(false)}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="confirm-modal-title">{confirmDialog.title}</h2>
            <p>{confirmDialog.message}</p>
            <div className="confirm-actions">
              <button type="button" className="secondary-button" onClick={() => closeConfirmDialog(false)}>
                Cancel
              </button>
              <button
                type="button"
                className={confirmDialog.variant === 'danger' ? 'danger-button' : 'action-button'}
                onClick={() => closeConfirmDialog(true)}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </section>
      )}

      <footer className="bottom-bar">
        <button
          type="button"
          className="download-button"
          data-tutorial-id="add-selected-to-queue"
          onClick={() => void handleDownload()}
          disabled={isDownloading || selected.size === 0 || !authReady}
        >
          {isDownloading ? 'Queue Running...' : `Add Selected To Queue (${selected.size})`}
        </button>
        <p className="disclaimer">Educational use only. This project is not affiliated with or endorsed by McGill University.</p>
      </footer>
    </main>
  );
}
