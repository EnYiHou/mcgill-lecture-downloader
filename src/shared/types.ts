export type StorageKey =
  | 'RecordingsInfo'
  | 'CoursesList'
  | 'Cookies'
  | 'MediaRecordings'
  | 'CoursesDigits'
  | 'downloadedItems';

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
}

export interface MediaSource {
  label: string;
}

export interface MediaRecordingDto {
  id: string;
  recordingName?: string;
  recordingTime: string;
  courseName: string;
  sources: MediaSource[];
}

export interface DownloadMediaInput {
  rid: string;
  fileName: string;
  formatLabel?: string;
  stoken: string;
  etime: string;
  onProgress?: (stage: string) => void;
}
