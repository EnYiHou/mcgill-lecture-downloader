import type { ExtensionStorage, StorageKey } from './types';
import { migrateLegacyDownloadedItems } from './downloadMarkers';

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

export async function readUiPreferences(): Promise<ExtensionStorage['uiPreferences']> {
  const value = await storageGet('uiPreferences');
  const defaults = {
    performanceMode: false,
    reducedMotion: false,
    showVisualEffects: true,
    menuCollapsed: false
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
  cookieHeader: string;
}> {
  const [recordings, mediaRecordings, courses, cookies] = await Promise.all([
    storageGet('RecordingsInfo'),
    storageGet('MediaRecordings'),
    storageGet('CoursesList'),
    storageGet('Cookies')
  ]);

  const stoken = recordings?.stoken ?? '';
  const etime = recordings?.etime ?? '';
  const bearer = mediaRecordings?.authorizationHeader?.value ?? '';
  const coursesList = courses?.coursesList ?? [];
  const cookieHeader = cookies?.cookies?.value ?? '';

  if (!stoken || !etime || !bearer || !coursesList.length || !cookieHeader) {
    throw new Error('Missing required auth/session data. Please open myCourses and play a lecture first.');
  }

  return {
    stoken,
    etime,
    bearer,
    coursesList,
    cookieHeader
  };
}

export async function readAuthReadiness(): Promise<{
  hasStoken: boolean;
  hasEtime: boolean;
  hasBearer: boolean;
  hasCourses: boolean;
  hasCookies: boolean;
}> {
  const [recordings, mediaRecordings, courses, cookies] = await Promise.all([
    storageGet('RecordingsInfo'),
    storageGet('MediaRecordings'),
    storageGet('CoursesList'),
    storageGet('Cookies')
  ]);

  return {
    hasStoken: Boolean(recordings?.stoken),
    hasEtime: Boolean(recordings?.etime),
    hasBearer: Boolean(mediaRecordings?.authorizationHeader?.value),
    hasCourses: Boolean(courses?.coursesList?.length),
    hasCookies: Boolean(cookies?.cookies?.value)
  };
}
