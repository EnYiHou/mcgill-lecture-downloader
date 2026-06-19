import {
  Suspense,
  lazy,
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
  clearDebugLogs,
  readDebugLogs,
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
  courseDigits: string[];
  cookieHeader: string;
}

interface AuthReadinessState {
  hasStoken: boolean;
  hasEtime: boolean;
  hasBearer: boolean;
  hasCourses: boolean;
  hasCourseDigits: boolean;
  hasCookies: boolean;
}

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'default' | 'danger';
  resolve: (confirmed: boolean) => void;
}

type MenuTab = 'courses' | 'library' | 'queue' | 'guide';

const TAB_ORDER: readonly MenuTab[] = ['courses', 'library', 'queue', 'guide'];
const PARENT_MESSAGE_SOURCE = 'mclecture';
const PARENT_MESSAGE_TYPE_DOWNLOAD_STATE = 'download-state';
const SCREENSHOT_MODE = import.meta.env.MODE === 'screenshots';

type ScreenshotScenario = 'popup' | 'downloading' | 'help';

interface ScreenshotFixtureState {
  scenario: ScreenshotScenario;
  activeTab: MenuTab;
  courses: UiCourse[];
  courseCatalog: CourseCatalogEntry[];
  hiddenCourseDigits: Set<string>;
  selected: Set<string>;
  downloaded: Set<string>;
  auth: AuthState;
  authReadiness: AuthReadinessState;
  uiPreferences: UiPreferences;
  isLoading: boolean;
  isDownloading: boolean;
  activeDownloadTotal: number;
  activeDownloadCompleted: number;
  statusMessage: string;
  errorMessage: string;
  queueItems: DownloadQueueItem[];
  showTutorialNotice: boolean;
  showCourseActions: boolean;
  mediaSizeBytesByKey: Record<string, number | null>;
  selectedFormatByKey: Record<string, string>;
  embedCaptions: boolean;
  debugLogs: string[];
  debugReportText: string;
}

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

  return (
    readiness.hasStoken &&
    readiness.hasEtime &&
    readiness.hasBearer &&
    (readiness.hasCourses || readiness.hasCourseDigits) &&
    readiness.hasCookies
  );
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

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to a document-based copy path below.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

function getScreenshotScenario(): ScreenshotScenario | null {
  if (!SCREENSHOT_MODE) {
    return null;
  }

  const value = new URLSearchParams(window.location.search).get('screenshot');
  if (value === 'popup' || value === 'downloading' || value === 'help') {
    return value;
  }

  return 'popup';
}

function buildScreenshotMediaItem(
  courseDigit: string,
  id: string,
  filename: string,
  recordingName: string,
  recordingTime: string,
  uploadedAt: string,
  options?: {
    caption?: boolean;
    primaryFormat?: string;
  }
): UiMediaItem {
  const downloadMarker = createDownloadMarker(courseDigit, id);
  const captionSrc = options?.caption ? 'https://example.invalid/mclecture-captions.vtt' : null;

  return {
    key: `${downloadMarker}::${filename}`,
    courseDigit,
    id,
    downloadMarker,
    filename,
    recordingName,
    recordingTime,
    uploadedAt,
    videoType: options?.primaryFormat ?? 'HD',
    formatOptions: [
      { label: 'HD', resolution: '720' },
      { label: 'VGA', resolution: '360' },
      { label: 'Audio', resolution: null }
    ],
    captionSrc,
    captionLanguage: captionSrc ? 'en' : null,
    captionLabel: captionSrc ? 'English' : null
  };
}

function buildScreenshotFixture(): ScreenshotFixtureState | null {
  const scenario = getScreenshotScenario();
  if (!scenario) {
    return null;
  }

  const courseDigit = '843221';
  const now = Date.now();
  const media = [
    buildScreenshotMediaItem(
      courseDigit,
      'sample-recording-001',
      'COMP551AppliedMachineLearning_01',
      'Lecture 12 - Representation Learning',
      'Mar 18, 2026, 10:05 AM',
      'Mar 18, 2026, 11:42 AM',
      { caption: true, primaryFormat: 'HD' }
    ),
    buildScreenshotMediaItem(
      courseDigit,
      'sample-recording-002',
      'COMP551AppliedMachineLearning_02',
      'Tutorial 05 - Policy Gradients',
      'Mar 21, 2026, 2:35 PM',
      'Mar 21, 2026, 3:12 PM',
      { caption: true, primaryFormat: 'VGA' }
    ),
    buildScreenshotMediaItem(
      courseDigit,
      'sample-recording-003',
      'COMP551AppliedMachineLearning_03',
      'Review - Midterm Practice',
      'Mar 25, 2026, 4:00 PM',
      'Mar 25, 2026, 5:08 PM',
      { primaryFormat: 'HD' }
    )
  ];

  const courses: UiCourse[] = [
    {
      courseDigit,
      courseListId: 'sample-course-list-001',
      title: 'COMP 551 Applied Machine Learning, ID: 843221',
      media,
      expanded: true
    }
  ];
  const courseCatalog: CourseCatalogEntry[] = [
    {
      courseDigit,
      title: courses[0].title,
      courseListId: courses[0].courseListId,
      lastSeenAt: now
    },
    {
      courseDigit: '729114',
      title: 'MATH 323 Probability, ID: 729114',
      courseListId: 'sample-course-list-002',
      lastSeenAt: now - 86_400_000
    }
  ];
  const selected = scenario === 'help' ? new Set<string>() : new Set([media[1].key, media[2].key]);
  const downloaded = new Set([media[0].downloadMarker, createLegacyFilenameMarker(media[0].filename)]);
  const selectedFormatByKey: Record<string, string> = {
    [media[0].key]: 'HD',
    [media[1].key]: 'VGA',
    [media[2].key]: 'HD'
  };
  const mediaSizeBytesByKey: Record<string, number | null> = {
    [`${media[0].key}::HD`]: 1_428_742_144,
    [`${media[1].key}::VGA`]: 482_344_960,
    [`${media[2].key}::HD`]: 948_183_040
  };
  const authReadiness: AuthReadinessState = {
    hasStoken: true,
    hasEtime: true,
    hasBearer: true,
    hasCourses: true,
    hasCourseDigits: true,
    hasCookies: true
  };
  const auth: AuthState = {
    stoken: 'sample-stoken',
    etime: '1893456000',
    bearer: 'sample-bearer',
    coursesList: ['sample-course-list-001', 'sample-course-list-002'],
    courseDigits: ['843221', '729114'],
    cookieHeader: 'sample_cookie=true'
  };
  const uiPreferences: UiPreferences = {
    performanceMode: true,
    reducedMotion: true,
    showVisualEffects: false,
    menuCollapsed: false,
    remuxToMp4: true
  };
  const queueItems: DownloadQueueItem[] = [
    {
      key: media[0].key,
      courseDigit,
      rid: media[0].id,
      downloadMarker: media[0].downloadMarker,
      fileName: media[0].filename,
      videoType: 'HD',
      remuxToMp4: true,
      captionSrc: media[0].captionSrc,
      captionLanguage: media[0].captionLanguage,
      embedCaptions: true,
      recordingName: media[0].recordingName,
      status: 'downloading'
    },
    {
      key: media[1].key,
      courseDigit,
      rid: media[1].id,
      downloadMarker: media[1].downloadMarker,
      fileName: media[1].filename,
      videoType: 'VGA',
      remuxToMp4: true,
      captionSrc: media[1].captionSrc,
      captionLanguage: media[1].captionLanguage,
      embedCaptions: true,
      recordingName: media[1].recordingName,
      status: 'queued'
    },
    {
      key: media[2].key,
      courseDigit,
      rid: media[2].id,
      downloadMarker: media[2].downloadMarker,
      fileName: media[2].filename,
      videoType: 'HD',
      remuxToMp4: true,
      captionSrc: media[2].captionSrc,
      captionLanguage: media[2].captionLanguage,
      embedCaptions: false,
      recordingName: media[2].recordingName,
      status: 'failed',
      error: 'Sample failure: stream token expired before retry.'
    },
    {
      key: `${courseDigit}::sample-recording-004::COMP551AppliedMachineLearning_04`,
      courseDigit,
      rid: 'sample-recording-004',
      downloadMarker: createDownloadMarker(courseDigit, 'sample-recording-004'),
      fileName: 'COMP551AppliedMachineLearning_04',
      videoType: 'HD',
      remuxToMp4: true,
      captionSrc: null,
      captionLanguage: null,
      embedCaptions: false,
      recordingName: 'Office Hours - Exam Strategy',
      status: 'done'
    }
  ];

  return {
    scenario,
    activeTab: scenario === 'help' ? 'guide' : scenario === 'downloading' ? 'queue' : 'courses',
    courses,
    courseCatalog,
    hiddenCourseDigits: new Set(),
    selected,
    downloaded,
    auth,
    authReadiness,
    uiPreferences,
    isLoading: false,
    isDownloading: scenario === 'downloading',
    activeDownloadTotal: scenario === 'downloading' ? 4 : 0,
    activeDownloadCompleted: scenario === 'downloading' ? 1 : 0,
    statusMessage: scenario === 'downloading' ? 'Remuxing Lecture 12 - Representation Learning' : 'Fixture data loaded.',
    errorMessage: '',
    queueItems: scenario === 'downloading' ? queueItems : [],
    showTutorialNotice: false,
    showCourseActions: false,
    mediaSizeBytesByKey,
    selectedFormatByKey,
    embedCaptions: true,
    debugLogs: [
      '[2026-03-25T18:15:00.000Z] Captured sample stream token.',
      '[2026-03-25T18:15:04.000Z] Loaded 2 sample courses.',
      '[2026-03-25T18:15:07.000Z] Queue fixture initialized for screenshot mode.'
    ],
    debugReportText: ''
  };
}

export function App() {
  const screenshotFixture = useMemo(() => buildScreenshotFixture(), []);
  const [activeTab, setActiveTab] = useState<MenuTab>(screenshotFixture?.activeTab ?? 'courses');
  const [courses, setCourses] = useState<UiCourse[]>(screenshotFixture?.courses ?? []);
  const [courseCatalog, setCourseCatalog] = useState<CourseCatalogEntry[]>(screenshotFixture?.courseCatalog ?? []);
  const [hiddenCourseDigits, setHiddenCourseDigits] = useState<Set<string>>(
    screenshotFixture?.hiddenCourseDigits ?? new Set()
  );
  const [selected, setSelected] = useState<Set<string>>(screenshotFixture?.selected ?? new Set());
  const [downloaded, setDownloaded] = useState<Set<string>>(screenshotFixture?.downloaded ?? new Set());
  const [auth, setAuth] = useState<AuthState | null>(screenshotFixture?.auth ?? null);
  const [authReadiness, setAuthReadiness] = useState<AuthReadinessState | null>(
    screenshotFixture?.authReadiness ?? null
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [showCourseActions, setShowCourseActions] = useState(screenshotFixture?.showCourseActions ?? false);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>({
    ...(screenshotFixture?.uiPreferences ?? {
    performanceMode: false,
    reducedMotion: false,
    showVisualEffects: true,
    menuCollapsed: false,
    remuxToMp4: true
    })
  });

  const [isLoading, setIsLoading] = useState(screenshotFixture?.isLoading ?? true);
  const [isDownloading, setIsDownloading] = useState(screenshotFixture?.isDownloading ?? false);
  const [activeDownloadTotal, setActiveDownloadTotal] = useState(screenshotFixture?.activeDownloadTotal ?? 0);
  const [activeDownloadCompleted, setActiveDownloadCompleted] = useState(
    screenshotFixture?.activeDownloadCompleted ?? 0
  );
  const [statusMessage, setStatusMessage] = useState(screenshotFixture?.statusMessage ?? '');
  const [errorMessage, setErrorMessage] = useState(screenshotFixture?.errorMessage ?? '');
  const [queueItems, setQueueItems] = useState<DownloadQueueItem[]>(screenshotFixture?.queueItems ?? []);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [showTutorialNotice, setShowTutorialNotice] = useState(screenshotFixture?.showTutorialNotice ?? false);
  const [mediaSizeBytesByKey, setMediaSizeBytesByKey] = useState<Record<string, number | null>>(
    screenshotFixture?.mediaSizeBytesByKey ?? {}
  );
  const [selectedFormatByKey, setSelectedFormatByKey] = useState<Record<string, string>>(
    screenshotFixture?.selectedFormatByKey ?? {}
  );
  const [embedCaptions, setEmbedCaptions] = useState(screenshotFixture?.embedCaptions ?? true);
  const [debugLogs, setDebugLogs] = useState<string[]>(screenshotFixture?.debugLogs ?? []);
  const [debugReportText, setDebugReportText] = useState(screenshotFixture?.debugReportText ?? '');

  const abortControllerRef = useRef<AbortController | null>(null);
  const appShellRef = useRef<HTMLElement | null>(null);
  const stopRequestedRef = useRef(false);
  const cancelRequestedKeysRef = useRef<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const loadRunRef = useRef(0);
  const parentOriginRef = useRef<string>('*');
  const channelRef = useRef('');
  const mediaSizeFetchInFlightRef = useRef<Set<string>>(new Set());
  const keepAwakeRequestedRef = useRef(false);
  const logoUrl = chrome.runtime.getURL('icons/icon.png');

  const refreshDebugLogs = useCallback(async () => {
    setDebugLogs(await readDebugLogs());
  }, []);

  const handleCopyDebugReport = useCallback(async () => {
    const report = [
      'McLecture debug report',
      `Generated at: ${new Date().toISOString()}`,
      `hasStoken: ${authReadiness?.hasStoken ?? false}`,
      `hasEtime: ${authReadiness?.hasEtime ?? false}`,
      `hasBearer: ${authReadiness?.hasBearer ?? false}`,
      `hasCourses: ${authReadiness?.hasCourses ?? false}`,
      `hasCourseDigits: ${authReadiness?.hasCourseDigits ?? false}`,
      `hasCookies: ${authReadiness?.hasCookies ?? false}`,
      `capturedCourseListIds: ${auth?.coursesList.length ?? 0}`,
      `capturedCourseDigits: ${auth?.courseDigits.length ?? 0}`,
      `loadedCourses: ${courses.length}`,
      `savedCourseCatalogEntries: ${courseCatalog.length}`,
      '',
      'Recent debug logs:',
      ...(debugLogs.length > 0 ? debugLogs : ['(none)'])
    ].join('\n');

    setDebugReportText(report);

    try {
      const copied = await copyText(report);
      if (!copied) {
        setErrorMessage('Automatic copy failed. Use the report box below to copy the text manually.');
        return;
      }
      setStatusMessage('Copied debug report to clipboard.');
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(`Failed to copy debug report: ${toErrorMessage(error)}`);
    }
  }, [auth?.coursesList.length, authReadiness, courseCatalog.length, courses.length, debugLogs]);

  const handleClearDebugLogs = useCallback(async () => {
    await clearDebugLogs();
    setDebugLogs([]);
    setStatusMessage('Cleared debug logs.');
  }, []);

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
  const courseSummaryStats = useMemo(() => {
    const visibleMediaCount = visibleCourses.reduce((count, course) => count + course.media.length, 0);
    const visibleDownloadedCount = visibleCourses.reduce(
      (count, course) => count + course.media.filter((item) => isMediaDownloaded(item)).length,
      0
    );
    const visibleNotDownloadedCount = visibleMediaCount - visibleDownloadedCount;

    return {
      totalCourses: courseCatalog.length || courses.length,
      visibleCourses: filteredCourses.length,
      visibleMediaCount,
      visibleDownloadedCount,
      visibleNotDownloadedCount
    };
  }, [courseCatalog.length, courses.length, filteredCourses.length, isMediaDownloaded, visibleCourses]);

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
        hasCourseDigits: false,
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
      setShowTutorialNotice(!tutorialSeen);
      setDownloaded(downloadedItems);
      setAuthReadiness(readiness);
      setDebugLogs(await readDebugLogs());

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
        const title = resolved.contextTitle ?? `Course ID: ${resolved.courseDigit}`;
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

      for (const courseDigit of authData.courseDigits) {
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
    if (screenshotFixture) {
      return;
    }

    void loadInitialState();
  }, [loadInitialState, screenshotFixture]);

  useEffect(() => {
    if (screenshotFixture) {
      return;
    }

    void refreshDebugLogs();
  }, [refreshDebugLogs, screenshotFixture]);

  useEffect(() => {
    if (screenshotFixture) {
      return;
    }

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
  }, [auth, courses, mediaSizeBytesByKey, selectedFormatByKey, screenshotFixture]);

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

  const dismissTutorialNotice = useCallback(async () => {
    setShowTutorialNotice(false);
    await storageSet('quickTutorialSeen', true);
  }, []);

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

    const preparedQueue: DownloadQueueItem[] = queueItems.map((item) => {
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

    const preparedQueue: DownloadQueueItem[] = queueItems.map((entry) => {
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
    <main
      ref={appShellRef}
      className={`app-shell fade-in ${uiPreferences.reducedMotion ? 'reduce-motion' : ''}`}
      data-screenshot-ready={screenshotFixture ? 'true' : undefined}
      data-screenshot-scenario={screenshotFixture?.scenario}
    >
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
            {activeTab === 'courses' && (
              <div className="header-meta">
                <span>{courseSummaryStats.visibleMediaCount} recordings</span>
                <span>{courseSummaryStats.visibleDownloadedCount} downloaded</span>
                <span>{courseSummaryStats.visibleNotDownloadedCount} not downloaded</span>
              </div>
            )}
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
              {showTutorialNotice && (
                <section className="tutorial-text-panel smooth-enter" aria-live="polite">
                  <h3>Quick Start</h3>
                  <p>Open myCourses and play one lecture first, then refresh Courses here, select recordings, and add them to Queue.</p>
                  <button type="button" className="secondary-button" onClick={() => void dismissTutorialNotice()}>
                    Dismiss
                  </button>
                </section>
              )}
              {!authReady && !isLoading ? (
                <section className="onboarding-panel smooth-enter">
                  <h2>Setup Required</h2>
                  <p>Complete these steps on myCourses before refreshing courses:</p>
                  <ol>
                    <li className={authReadiness?.hasCookies ? 'done' : ''}>Open and log in to myCourses.</li>
                    <li className={authReadiness?.hasCourses || authReadiness?.hasCourseDigits ? 'done' : ''}>
                      Open one course page with lecture recordings.
                    </li>
                    <li className={authReadiness?.hasBearer ? 'done' : ''}>Play one lecture to capture API authorization.</li>
                    <li className={authReadiness?.hasStoken && authReadiness?.hasEtime ? 'done' : ''}>
                      Let the lecture load so stream tokens are captured.
                    </li>
                  </ol>
                  <div className="bulk-actions">
                    <button
                      type="button"
                      className="action-button"
                      onClick={() => void loadInitialState()}
                    >
                      Re-check Setup
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
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
                        onClick={() => window.open('https://mycourses2.mcgill.ca', '_blank', 'noopener,noreferrer')}
                      >
                        Open myCourses
                      </button>
                      <button
                        type="button"
                        className="action-button"
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
                      const totalCount = course.media.length;
                      const downloadedCount = course.media.filter((item) => isMediaDownloaded(item)).length;
                      const allSelected = selectedCount === totalCount && totalCount > 0;
                      const notDownloadedCount = course.media.filter((item) => !isMediaDownloaded(item)).length;
                      const notDownloadedSelected =
                        notDownloadedCount > 0 && course.media.filter((item) => !isMediaDownloaded(item)).every((item) => selected.has(item.key));

                      return (
                        <article key={course.courseDigit} className="course-card smooth-enter">
                          <button
                            type="button"
                            className="course-header"
                            onClick={() => toggleCourseExpansion(course.courseDigit)}
                            aria-expanded={course.expanded}
                          >
                            <span className="course-title-row">
                              <span className="course-title-text">{course.title}</span>
                              <span className={`chevron ${course.expanded ? 'open' : ''}`}>▾</span>
                            </span>
                            <span className="course-header-stats" aria-label={`Stats for ${course.title}`}>
                              <span className="course-stat-chip">
                                <strong>{totalCount}</strong>
                                <small>Total</small>
                              </span>
                              <span className="course-stat-chip">
                                <strong>{downloadedCount}</strong>
                                <small>Downloaded</small>
                              </span>
                              <span className="course-stat-chip">
                                <strong>{selectedCount}</strong>
                                <small>Selected</small>
                              </span>
                            </span>
                          </button>

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

              <section className="permissions-panel">
                <h3>Capture Diagnostics</h3>
                <p>
                  The course discovery step currently depends on a Brightspace notifications request firing while you browse myCourses.
                  If that request does not happen, the extension may capture stream tokens and auth headers but still show no courses.
                </p>
                <ul>
                  <li>`hasStoken`: {authReadiness?.hasStoken ? 'yes' : 'no'}</li>
                  <li>`hasEtime`: {authReadiness?.hasEtime ? 'yes' : 'no'}</li>
                  <li>`hasBearer`: {authReadiness?.hasBearer ? 'yes' : 'no'}</li>
                  <li>`hasCourses`: {authReadiness?.hasCourses ? 'yes' : 'no'}</li>
                  <li>`hasCourseDigits`: {authReadiness?.hasCourseDigits ? 'yes' : 'no'}</li>
                  <li>`hasCookies`: {authReadiness?.hasCookies ? 'yes' : 'no'}</li>
                  <li>`capturedCourseListIds`: {auth?.coursesList.length ?? 0}</li>
                  <li>`capturedCourseDigits`: {auth?.courseDigits.length ?? 0}</li>
                  <li>`savedCourseCatalogEntries`: {courseCatalog.length}</li>
                </ul>
                <div className="queue-controls smooth-enter">
                  <button type="button" className="secondary-button" onClick={() => void refreshDebugLogs()}>
                    Refresh Debug Info
                  </button>
                  <button type="button" className="secondary-button" onClick={() => void handleCopyDebugReport()}>
                    Copy Debug Report
                  </button>
                  <button type="button" className="danger-button" onClick={() => void handleClearDebugLogs()}>
                    Clear Debug Logs
                  </button>
                </div>
                {debugReportText ? (
                  <textarea
                    value={debugReportText}
                    readOnly
                    rows={10}
                    onFocus={(event) => event.currentTarget.select()}
                    aria-label="Debug report text"
                    className="error-banner smooth-enter"
                  />
                ) : null}
                <pre className="error-banner smooth-enter">{debugLogs.length > 0 ? debugLogs.join('\n') : 'No debug logs captured yet.'}</pre>
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
