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

type MenuTab = 'courses' | 'library' | 'queue' | 'guide';

const TAB_ORDER: readonly MenuTab[] = ['courses', 'library', 'queue', 'guide'];
const PARENT_MESSAGE_SOURCE = 'mclecture';
const PARENT_MESSAGE_TYPE_DOWNLOAD_STATE = 'download-state';

function normalizeFilename(courseName: string, index: number): string {
  return `${courseName}_${index}`.replace(/\s+/g, '');
}

function buildCourseTitle(fallback: string | undefined, mediaList: MediaRecordingDto[], courseDigit: string): string {
  if (fallback) {
    return `${fallback}, ID: ${courseDigit}`;
  }
  if (mediaList[0]?.courseName) {
    return `${mediaList[0].courseName}, ID: ${courseDigit}`;
  }
  return `Course ID: ${courseDigit}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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
  const [isPaused, setIsPaused] = useState(false);
  const [activeDownloadTotal, setActiveDownloadTotal] = useState(0);
  const [activeDownloadCompleted, setActiveDownloadCompleted] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [queueItems, setQueueItems] = useState<DownloadQueueItem[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [mediaSizeBytesByKey, setMediaSizeBytesByKey] = useState<Record<string, number | null>>({});
  const [selectedFormatByKey, setSelectedFormatByKey] = useState<Record<string, string>>({});
  const [embedCaptions, setEmbedCaptions] = useState(true);

  const abortControllerRef = useRef<AbortController | null>(null);
  const pauseRef = useRef(false);
  const pauseRequestedRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const loadRunRef = useRef(0);
  const parentOriginRef = useRef<string>('*');
  const channelRef = useRef('');
  const mediaSizeFetchInFlightRef = useRef<Set<string>>(new Set());
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

  const failedQueueItems = useMemo(() => queueItems.filter((item) => item.status === 'failed'), [queueItems]);

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

  const persistQueue = useCallback(async (items: DownloadQueueItem[], active: boolean, paused: boolean) => {
    const completed = items.filter((item) => item.status === 'done').length;
    const queueState: DownloadQueueState = {
      active,
      paused,
      completed,
      total: items.length,
      items,
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

    try {
      const [downloadedItems, previousQueue, storedCatalog, storedHidden, readiness, preferences] = await Promise.all([
        readDownloadedItems(),
        storageGet('downloadQueueState'),
        storageGet('courseCatalog'),
        storageGet('hiddenCourseDigits'),
        readAuthReadiness(),
        readUiPreferences()
      ]);

      if (runId !== loadRunRef.current) {
        return;
      }

      setUiPreferences(
        preferences ?? { performanceMode: false, reducedMotion: false, showVisualEffects: true, menuCollapsed: false, remuxToMp4: true }
      );
      setDownloaded(downloadedItems);
      setAuthReadiness(readiness);

      const hiddenList = storedHidden?.list ?? [];
      const hiddenSet = new Set(hiddenList);
      setHiddenCourseDigits(hiddenSet);
      setCourseCatalog(storedCatalog?.courses ?? []);

      if (previousQueue?.items?.length) {
        let restoredItems = previousQueue.items.map((item) => hydrateQueueItem(item));
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
          setStatusMessage('Previous queue was interrupted. You can retry failed items.');
          await persistQueue(restoredItems, false, false);
        }

        setQueueItems(restoredItems);
        setActiveDownloadTotal(restoredItems.length);
        setActiveDownloadCompleted(restoredItems.filter((item) => item.status === 'done').length);
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
      const visibleCourseListIds = new Set(
        catalogCourses
          .filter((entry) => !hiddenSet.has(entry.courseDigit) && Boolean(entry.courseListId))
          .map((entry) => entry.courseListId as string)
      );
      const hasCatalog = catalogCourses.length > 0;
      const resolvableCourseListIds = hasCatalog
        ? authData.coursesList.filter((courseListId) => visibleCourseListIds.has(courseListId))
        : authData.coursesList;
      const resolvedCourses = await mapWithConcurrency(resolvableCourseListIds, 3, async (courseListId) => {
        const resolved = await resolveCourseDigit(authData.cookieHeader, courseListId);
        if (!resolved.courseDigit) {
          return null;
        }
        const title = resolved.contextTitle
          ? `${resolved.contextTitle}, ID: ${resolved.courseDigit}`
          : `Course ID: ${resolved.courseDigit}`;
        return {
          courseDigit: resolved.courseDigit,
          title,
          courseListId
        };
      });

      if (runId !== loadRunRef.current) {
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

      const mergedCatalog = dedupeCourseCatalog([...(storedCatalog?.courses ?? []), ...catalogFromLoad]);
      setCourseCatalog(mergedCatalog);
      await storageSet('courseCatalog', { courses: mergedCatalog });

      const visibleCandidates = Array.from(candidateMap.values()).filter((course) => !hiddenSet.has(course.courseDigit));
      const courseResults = await mapWithConcurrency(visibleCandidates, 3, async (candidate) =>
        buildCourse(candidate.courseDigit, authData.bearer, candidate.title, candidate.courseListId)
      );

      if (runId !== loadRunRef.current) {
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

      setCourses(loadedCourses);
    } catch (error) {
      if (runId !== loadRunRef.current) {
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
        setIsPaused((previous) => {
          const next = !previous;
          pauseRef.current = next;
          void persistQueue(queueItems, true, next);
          return next;
        });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeTab, isDownloading, loadInitialState, persistQueue, queueItems]);

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
    const next = new Set<string>();
    visibleCourses.forEach((course) => {
      course.media.forEach((media) => {
        next.add(media.key);
      });
    });
    setSelected(next);
  };

  const handleSelectAllNotDownloaded = () => {
    const next = new Set<string>();
    visibleCourses.forEach((course) => {
      course.media.forEach((media) => {
        if (!isMediaDownloaded(media)) {
          next.add(media.key);
        }
      });
    });
    setSelected(next);
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

  const runQueue = useCallback(
    async (initialItems: DownloadQueueItem[]) => {
      if (!auth) {
        setErrorMessage('Missing auth/session data. Open myCourses and play a lecture, then refresh courses.');
        return;
      }

      const workingItems: DownloadQueueItem[] = initialItems.map((item) => ({ ...item, status: 'queued' }));
      setErrorMessage('');
      setIsDownloading(true);
      setIsPaused(false);
      pauseRef.current = false;
      pauseRequestedRef.current = false;
      stopRequestedRef.current = false;
      setQueueItems(workingItems);
      setActiveDownloadTotal(workingItems.length);
      setActiveDownloadCompleted(0);
      setActiveTab('queue');
      await persistQueue(workingItems, true, false);

      abortControllerRef.current = new AbortController();
      const localDownloaded = new Set(downloaded);
      const failures: string[] = [];
      let stopped = false;

      for (let index = 0; index < workingItems.length; index += 1) {
        while (pauseRef.current && !stopRequestedRef.current) {
          setStatusMessage('Queue paused. Resume to continue.');
          await sleep(200);
        }

        if (stopRequestedRef.current) {
          stopped = true;
          for (let j = index; j < workingItems.length; j += 1) {
            if (workingItems[j].status === 'queued' || workingItems[j].status === 'downloading') {
              workingItems[j] = { ...workingItems[j], status: 'canceled', error: 'Canceled by user.' };
            }
          }
          await persistQueue(workingItems, false, false);
          break;
        }

        const current = workingItems[index];
        workingItems[index] = { ...current, status: 'downloading' };
        setQueueItems([...workingItems]);
        await persistQueue(workingItems, true, pauseRef.current);
        if (!abortControllerRef.current || abortControllerRef.current.signal.aborted) {
          abortControllerRef.current = new AbortController();
        }

        setStatusMessage(`Downloading ${index + 1}/${workingItems.length}: ${current.recordingName}`);

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
              setStatusMessage(`${stage} (${index + 1}/${workingItems.length})`);
            }
          });

          localDownloaded.add(current.downloadMarker);
          localDownloaded.add(createLegacyFilenameMarker(current.fileName));
          setDownloaded(new Set(localDownloaded));
          await writeDownloadedItems(localDownloaded);

          workingItems[index] = { ...workingItems[index], status: 'done' };
          setActiveDownloadCompleted((prev) => prev + 1);
        } catch (error) {
          if (isAbortError(error)) {
            if (pauseRequestedRef.current) {
              workingItems[index] = { ...workingItems[index], status: 'queued', error: undefined };
              setQueueItems([...workingItems]);
              await persistQueue(workingItems, true, true);

              while (pauseRef.current && !stopRequestedRef.current) {
                setStatusMessage('Queue paused. Resume to continue.');
                await sleep(200);
              }

              if (stopRequestedRef.current) {
                stopped = true;
                workingItems[index] = { ...workingItems[index], status: 'canceled', error: 'Canceled by user.' };
                for (let j = index + 1; j < workingItems.length; j += 1) {
                  if (workingItems[j].status === 'queued') {
                    workingItems[j] = { ...workingItems[j], status: 'canceled', error: 'Canceled by user.' };
                  }
                }
                setQueueItems([...workingItems]);
                await persistQueue(workingItems, false, false);
                break;
              }

              pauseRequestedRef.current = false;
              abortControllerRef.current = new AbortController();
              index -= 1;
              continue;
            }

            stopped = true;
            workingItems[index] = { ...workingItems[index], status: 'canceled', error: 'Canceled by user.' };
            for (let j = index + 1; j < workingItems.length; j += 1) {
              if (workingItems[j].status === 'queued') {
                workingItems[j] = { ...workingItems[j], status: 'canceled', error: 'Canceled by user.' };
              }
            }
            setQueueItems([...workingItems]);
            await persistQueue(workingItems, false, false);
            break;
          }

          const err = toErrorMessage(error);
          workingItems[index] = { ...workingItems[index], status: 'failed', error: err };
          failures.push(`${current.fileName}: ${err}`);
        }

        setQueueItems([...workingItems]);
        await persistQueue(workingItems, true, pauseRef.current);
      }

      abortControllerRef.current = null;
      pauseRequestedRef.current = false;
      stopRequestedRef.current = false;
      setIsDownloading(false);
      setIsPaused(false);
      pauseRef.current = false;
      setStatusMessage(stopped ? 'Download stopped by user.' : '');

      setQueueItems([...workingItems]);
      await persistQueue(workingItems, false, false);

      if (failures.length > 0) {
        setErrorMessage(`Some downloads failed:\n${failures.join('\n')}`);
      }
    },
    [auth, downloaded, persistQueue]
  );

  const handleDownload = async () => {
    if (isDownloading) {
      return;
    }

    const chosen = Array.from(selected)
      .map((key) => mediaByKey.get(key))
      .filter((item): item is UiMediaItem => Boolean(item));

    if (chosen.length === 0) {
      setErrorMessage('Select at least one video before downloading.');
      return;
    }

    const queue = chosen.map(
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

    await runQueue(queue);
  };

  const handleRetryFailed = async () => {
    if (isDownloading || failedQueueItems.length === 0) {
      return;
    }

    const retryQueue: DownloadQueueItem[] = failedQueueItems.map((item) => ({
      ...item,
      status: 'queued',
      error: undefined
    }));

    await runQueue(retryQueue);
  };

  const handleRetryItem = async (item: DownloadQueueItem) => {
    if (isDownloading || item.status !== 'failed') {
      return;
    }

    await runQueue([
      {
        ...item,
        status: 'queued',
        error: undefined
      }
    ]);
  };

  const handleStopDownloading = async () => {
    if (!isDownloading) {
      return;
    }

    const shouldStop = await askForConfirmation({
      title: 'Stop Downloads?',
      message: 'Current and queued downloads will be canceled.',
      confirmLabel: 'Stop Downloads',
      variant: 'danger'
    });
    if (!shouldStop) {
      return;
    }

    stopRequestedRef.current = true;
    pauseRequestedRef.current = false;
    abortControllerRef.current?.abort();
  };

  const handleTogglePause = () => {
    if (!isDownloading) {
      return;
    }

    setIsPaused((previous) => {
      const next = !previous;
      pauseRef.current = next;
      if (next) {
        pauseRequestedRef.current = true;
        abortControllerRef.current?.abort();
      } else {
        pauseRequestedRef.current = false;
      }
      void persistQueue(queueItems, true, next);
      return next;
    });
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
    <main className={`app-shell fade-in ${uiPreferences.reducedMotion ? 'reduce-motion' : ''}`}>
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
            <p className="header-meta">
              {filteredCourses.length} visible / {courseCatalog.length || courses.length} saved
            </p>
          </header>

          {(isLoading || isDownloading || isPaused) && (
            <section className="progress-shell smooth-enter" aria-live="polite">
              <div className="spinner" />
              <p>
                {isDownloading
                  ? `${isPaused ? 'Paused' : statusMessage || 'Downloading...'} ${activeDownloadCompleted}/${activeDownloadTotal}`
                  : 'Loading courses...'}
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
                    <button type="button" className="action-button" onClick={() => void loadInitialState()}>
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
                    <button type="button" className="action-button" onClick={() => setShowCourseActions((prev) => !prev)}>
                      {showCourseActions ? 'Hide Actions' : 'Course Actions'}
                    </button>
                  </section>

                  {showCourseActions && (
                    <section className="bulk-actions smooth-enter">
                      <button type="button" className="action-button" onClick={() => void loadInitialState()}>
                        Refresh Courses
                      </button>
                      <button type="button" className="action-button" onClick={handleSelectAll} disabled={isDownloading}>
                        Select ALL
                      </button>
                      <button type="button" className="action-button" onClick={handleSelectAllNotDownloaded} disabled={isDownloading}>
                        Select ALL Non-Downloaded
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
                <h2>Queue</h2>
              </section>

              <section className="queue-controls smooth-enter">
                <button type="button" className="secondary-button" onClick={handleTogglePause} disabled={!isDownloading}>
                  {isPaused ? 'Resume' : 'Pause'}
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => void handleStopDownloading()}
                  disabled={!isDownloading}
                >
                  Stop
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleRetryFailed()}
                  disabled={isDownloading || failedQueueItems.length === 0}
                >
                  Retry Failed ({failedQueueItems.length})
                </button>
              </section>

              {queueItems.length > 0 ? (
                <section className="queue-panel">
                  <h3>Queue Status</h3>
                  <ul>
                    {queueItems.map((item) => (
                      <li key={item.key} className={`queue-item status-${item.status}`}>
                        <div>
                          <strong>{item.recordingName}</strong>
                          {item.error && <p className="queue-error">{item.error}</p>}
                        </div>
                        <div className="queue-item-controls">
                          <span>{statusLabel(item.status)}</span>
                          {item.status === 'failed' && (
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => void handleRetryItem(item)}
                              disabled={isDownloading}
                            >
                              Retry
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : (
                <p className="empty-state">No queue yet. Select videos in Courses and click Download Selected.</p>
              )}
            </section>
          )}

          {activeTab === 'guide' && (
            <section className="help-panel smooth-enter" id="panel-guide" role="tabpanel" aria-labelledby="tab-guide" tabIndex={0}>
              <h2>Usage Guide</h2>
              <ol>
                <li>Open myCourses, log in, and play one lecture video.</li>
                <li>Go to Courses tab and click Refresh Courses.</li>
                <li>Select recordings and click Download Selected.</li>
                <li>Use Queue tab controls to Pause, Stop, and Retry Failed downloads.</li>
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
          {isDownloading ? 'Downloading...' : `Download Selected (${selected.size})`}
        </button>
        <p className="disclaimer">Educational use only. This project is not affiliated with or endorsed by McGill University.</p>
      </footer>
    </main>
  );
}
