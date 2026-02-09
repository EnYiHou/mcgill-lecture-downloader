export type StorageKey =
  | 'RecordingsInfo'
  | 'CoursesList'
  | 'Cookies'
  | 'MediaRecordings'
  | 'CoursesDigits'
  | 'downloadedItems'
  | 'downloadQueueState'
  | 'uiPreferences'
  | 'courseCatalog'
  | 'hiddenCourseDigits'
  | 'overlayBounds';

export interface RecordingsInfo {
  url?: string;
  stoken?: string | null;
  etime?: string | null;
}

export interface CoursesList {
  coursesList: string[];
}

export interface CookiesInfo {
  cookies?: chrome.webRequest.HttpHeader;
}

export interface MediaRecordings {
  url?: string;
  authorizationHeader?: chrome.webRequest.HttpHeader;
}

export interface CoursesDigits {
  list: string[];
}

export interface ExtensionStorage {
  RecordingsInfo?: RecordingsInfo;
  CoursesList?: CoursesList;
  Cookies?: CookiesInfo;
  MediaRecordings?: MediaRecordings;
  CoursesDigits?: CoursesDigits;
  downloadedItems?: string[];
  downloadQueueState?: DownloadQueueState;
  uiPreferences?: UiPreferences;
  courseCatalog?: CourseCatalog;
  hiddenCourseDigits?: HiddenCourseDigits;
  overlayBounds?: OverlayBounds;
}

export interface MediaSource {
  src?: string;
  type?: string;
  label: string;
  res?: string;
}

export interface MediaDownloadOption {
  src?: string;
  type?: string;
  label?: string;
  res?: string;
}

export interface MediaCaptionOption {
  src?: string;
  type?: string;
  label?: string;
  res?: string;
}

export interface MediaRecordingDto {
  id: string;
  recordingName?: string;
  recordingTime?: string;
  dateTime?: string;
  dateCreated?: string;
  durationSeconds?: number;
  courseName: string;
  sources: MediaSource[];
  downloads?: MediaDownloadOption[] | null;
  captions?: MediaCaptionOption[] | null;
  captionsType?: string | null;
}

export interface DownloadMediaInput {
  rid: string;
  fileName: string;
  formatLabel?: string;
  stoken: string;
  etime: string;
  remuxToMp4?: boolean;
  bearerToken?: string;
  captionSrc?: string | null;
  captionLanguage?: string | null;
  embedCaptions?: boolean;
  onProgress?: (stage: string) => void;
  signal?: AbortSignal;
}

export type QueueItemStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'canceled';

export interface DownloadQueueItem {
  key: string;
  courseDigit: string;
  rid: string;
  downloadMarker: string;
  fileName: string;
  videoType: string;
  remuxToMp4?: boolean;
  captionSrc?: string | null;
  captionLanguage?: string | null;
  embedCaptions?: boolean;
  recordingName: string;
  status: QueueItemStatus;
  error?: string;
}

export interface DownloadQueueState {
  active: boolean;
  paused: boolean;
  completed: number;
  total: number;
  items: DownloadQueueItem[];
  updatedAt: number;
}

export interface UiPreferences {
  performanceMode: boolean;
  reducedMotion: boolean;
  showVisualEffects: boolean;
  menuCollapsed: boolean;
  remuxToMp4: boolean;
}

export interface CourseCatalogEntry {
  courseDigit: string;
  title: string;
  courseListId: string | null;
  lastSeenAt: number;
}

export interface CourseCatalog {
  courses: CourseCatalogEntry[];
}

export interface HiddenCourseDigits {
  list: string[];
}

export interface OverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  minimized: boolean;
}
