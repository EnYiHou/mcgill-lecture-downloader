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

async function appendDebugLog(message: string): Promise<void> {
  try {
    const existing = (await storageGet<{ entries?: string[] }>('debugLogs')) ?? {};
    const entries = Array.isArray(existing.entries) ? existing.entries : [];
    const timestamp = new Date().toISOString();
    const nextEntries = [...entries, `[${timestamp}] ${message}`].slice(-80);
    await storageSet('debugLogs', { entries: nextEntries });
  } catch {
    // Ignore debug log failures so capture logic keeps working.
  }
}

async function captureCourseListId(courseListId: string, source: string): Promise<void> {
  if (!courseListId) {
    return;
  }

  const existing = (await storageGet<CoursesList>('CoursesList')) ?? { coursesList: [] };
  if (!existing.coursesList.includes(courseListId)) {
    existing.coursesList.push(courseListId);
    await storageSet('CoursesList', { coursesList: existing.coursesList });
  }
  await appendDebugLog(`Captured courseListId=${courseListId} from ${source}`);
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
          await appendDebugLog(
            `Captured stream token request from tsmedia (stoken=${value.stoken ? 'yes' : 'no'}, etime=${value.etime ? 'yes' : 'no'})`
          );
          return;
        }

        if (details.url.includes('notifications.api.brightspace.com')) {
          const courseId = details.url.split('/').pop() ?? '';
          if (!courseId) {
            await appendDebugLog(`Saw Brightspace notifications request but could not parse courseListId: ${details.url}`);
            return;
          }

          await captureCourseListId(courseId, 'Brightspace notifications request');
          return;
        }

        if (details.url.includes(MYCOURSES_HOST)) {
          const url = new URL(details.url);
          const ltiMatch = url.pathname.match(/\/d2l\/le\/lti\/(\d+)\/toolLaunch\//);
          if (ltiMatch?.[1] && ltiMatch[1] !== '6606') {
            await captureCourseListId(ltiMatch[1], 'myCourses toolLaunch URL');
          }

          const cookieHeader = details.requestHeaders?.find(
            (header) => header.name.toLowerCase() === 'cookie'
          );
          const value: CookiesInfo = {
            cookies: cookieHeader
          };
          await storageSet('Cookies', value);
          await appendDebugLog(`Captured myCourses cookies header (${cookieHeader?.value ? 'present' : 'missing'})`);
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
            await appendDebugLog(`Captured media recordings auth header but could not parse course digit: ${details.url}`);
            return;
          }

          const existing = (await storageGet<CoursesDigits>('CoursesDigits')) ?? { list: [] };
          if (!existing.list.includes(courseDigit)) {
            existing.list.push(courseDigit);
          }

          await storageSet('CoursesDigits', { list: existing.list });
          await appendDebugLog(
            `Captured media recordings auth for courseDigit=${courseDigit} (authorization=${authorizationHeader?.value ? 'present' : 'missing'})`
          );
        }
      } catch (error) {
        await appendDebugLog(`Header capture failed: ${error instanceof Error ? error.message : String(error)}`);
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
