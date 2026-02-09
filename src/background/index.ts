import type { CoursesDigits, CoursesList, CookiesInfo, MediaRecordings, RecordingsInfo } from '../shared/types';

const MYCOURSES_HOST = 'mycourses2.mcgill.ca';
const CAPTURE_URLS = [
  'https://lrscdn.mcgill.ca/api/tsmedia/*',
  'https://lrswapi.campus.mcgill.ca/api/MediaRecordings/dto/*',
  'https://*.notifications.api.brightspace.com/my-notifications/organizations/*',
  'https://mycourses2.mcgill.ca/*'
];

function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result[key] as T | undefined);
    });
  });
}

function storageSet<T>(key: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details): chrome.webRequest.BlockingResponse | undefined => {
    void (async () => {
      try {
        if (details.method !== 'GET') {
          return;
        }

        if (details.url.includes('https://lrscdn.mcgill.ca/api/tsmedia')) {
          const url = new URL(details.url);
          const value: RecordingsInfo = {
            url: details.url,
            stoken: url.searchParams.get('stoken'),
            etime: url.searchParams.get('etime')
          };
          await storageSet('RecordingsInfo', value);
          return;
        }

        if (details.url.includes('notifications.api.brightspace.com')) {
          const courseId = details.url.split('/').pop() ?? '';
          if (!courseId) {
            return;
          }

          const existing = (await storageGet<CoursesList>('CoursesList')) ?? { coursesList: [] };
          if (!existing.coursesList.includes(courseId)) {
            existing.coursesList.push(courseId);
          }

          await storageSet('CoursesList', { coursesList: existing.coursesList });
          return;
        }

        if (details.url.includes(MYCOURSES_HOST)) {
          const cookieHeader = details.requestHeaders?.find(
            (header) => header.name.toLowerCase() === 'cookie'
          );
          const value: CookiesInfo = {
            cookies: cookieHeader
          };
          await storageSet('Cookies', value);
          return;
        }

        if (details.url.includes('api/MediaRecordings/dto')) {
          const authorizationHeader = details.requestHeaders?.find(
            (header) => header.name.toLowerCase() === 'authorization'
          );

          const mediaRecordings: MediaRecordings = {
            url: details.url,
            authorizationHeader
          };
          await storageSet('MediaRecordings', mediaRecordings);

          const courseDigit = details.url.split('/').pop() ?? '';
          if (!courseDigit) {
            return;
          }

          const existing = (await storageGet<CoursesDigits>('CoursesDigits')) ?? { list: [] };
          if (!existing.list.includes(courseDigit)) {
            existing.list.push(courseDigit);
          }

          await storageSet('CoursesDigits', { list: existing.list });
        }
      } catch (error) {
        console.error('McLecture header capture failed', error);
      }
    })();

    return { requestHeaders: details.requestHeaders };
  },
  {
    urls: CAPTURE_URLS
  },
  ['requestHeaders', 'extraHeaders']
);

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) {
    return;
  }

  const openOverlayByMessage = new Promise<boolean>((resolve) => {
    chrome.tabs.sendMessage(tab.id as number, { type: 'mclecture-open-overlay' }, (response: unknown) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }

      const handled =
        typeof response === 'object' &&
        response !== null &&
        'handled' in response &&
        Boolean((response as { handled?: boolean }).handled);
      resolve(handled);
    });
  });

  void openOverlayByMessage.then((handled) => {
    if (handled) {
      return;
    }

    void chrome.scripting
      .executeScript({
        target: { tabId: tab.id as number },
        files: ['js/content.js']
      })
      .catch((error: unknown) => {
        console.warn('McLecture overlay injection failed for current tab', error);
      });
  });
});
