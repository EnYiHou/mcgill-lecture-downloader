import type { ExtensionStorage, StorageKey } from './types';

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
  return new Set(Array.isArray(value) ? value : []);
}

export async function writeDownloadedItems(items: Set<string>): Promise<void> {
  await storageSet('downloadedItems', Array.from(items));
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
