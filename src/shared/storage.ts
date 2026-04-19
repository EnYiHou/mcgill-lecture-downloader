import type { ExtensionStorage, StorageKey } from './types';
import { migrateLegacyDownloadedItems } from './downloadMarkers';

const DEBUG_LOG_LIMIT = 80;

export async function storageGet<K extends StorageKey>(key: K): Promise<ExtensionStorage[K]> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result: Partial<ExtensionStorage>) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result[key] as ExtensionStorage[K]);
    });
  });
}

export async function storageSet<K extends StorageKey>(key: K, value: ExtensionStorage[K]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function readDownloadedItems(): Promise<Set<string>> {
  const value = await storageGet('downloadedItems');
  return migrateLegacyDownloadedItems(Array.isArray(value) ? value : []);
}

export async function writeDownloadedItems(items: Set<string>): Promise<void> {
  await storageSet('downloadedItems', Array.from(items));
}

export async function appendDebugLog(message: string): Promise<void> {
  const timestamp = new Date().toISOString();
  const existing = await storageGet('debugLogs');
  const entries = existing?.entries ?? [];
  const nextEntries = [...entries, `[${timestamp}] ${message}`].slice(-DEBUG_LOG_LIMIT);
  await storageSet('debugLogs', { entries: nextEntries });
}

export async function readDebugLogs(): Promise<string[]> {
  const value = await storageGet('debugLogs');
  return value?.entries ?? [];
}

export async function clearDebugLogs(): Promise<void> {
  await storageSet('debugLogs', { entries: [] });
}

export async function readUiPreferences(): Promise<ExtensionStorage['uiPreferences']> {
  const value = await storageGet('uiPreferences');
  const defaults = {
    performanceMode: false,
    reducedMotion: false,
    showVisualEffects: true,
    menuCollapsed: false,
    remuxToMp4: true
  };

  if (!value) {
    return defaults;
  }

  return {
    ...defaults,
    ...value
  };
}

export async function readRequiredAuthData(): Promise<{
  stoken: string;
  etime: string;
  bearer: string;
  coursesList: string[];
  courseDigits: string[];
  cookieHeader: string;
}> {
  const [recordings, mediaRecordings, courses, courseDigits, cookies] = await Promise.all([
    storageGet('RecordingsInfo'),
    storageGet('MediaRecordings'),
    storageGet('CoursesList'),
    storageGet('CoursesDigits'),
    storageGet('Cookies')
  ]);

  const stoken = recordings?.stoken ?? '';
  const etime = recordings?.etime ?? '';
  const bearer = mediaRecordings?.authorizationHeader?.value ?? '';
  const coursesList = courses?.coursesList ?? [];
  const capturedCourseDigits = courseDigits?.list ?? [];
  const cookieHeader = cookies?.cookies?.value ?? '';

  if (!stoken || !etime || !bearer || (!coursesList.length && !capturedCourseDigits.length) || !cookieHeader) {
    throw new Error('Missing required auth/session data. Please open myCourses and play a lecture first.');
  }

  return {
    stoken,
    etime,
    bearer,
    coursesList,
    courseDigits: capturedCourseDigits,
    cookieHeader
  };
}

export async function readAuthReadiness(): Promise<{
  hasStoken: boolean;
  hasEtime: boolean;
  hasBearer: boolean;
  hasCourses: boolean;
  hasCourseDigits: boolean;
  hasCookies: boolean;
}> {
  const [recordings, mediaRecordings, courses, courseDigits, cookies] = await Promise.all([
    storageGet('RecordingsInfo'),
    storageGet('MediaRecordings'),
    storageGet('CoursesList'),
    storageGet('CoursesDigits'),
    storageGet('Cookies')
  ]);

  return {
    hasStoken: Boolean(recordings?.stoken),
    hasEtime: Boolean(recordings?.etime),
    hasBearer: Boolean(mediaRecordings?.authorizationHeader?.value),
    hasCourses: Boolean(courses?.coursesList?.length),
    hasCourseDigits: Boolean(courseDigits?.list?.length),
    hasCookies: Boolean(cookies?.cookies?.value)
  };
}
