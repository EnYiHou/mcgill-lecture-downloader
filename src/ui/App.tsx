import { useCallback, useEffect, useMemo, useState } from 'react';
import { downloadAndRemuxMedia } from '../shared/download';
import { fetchCourseMediaList, resolveCourseDigit } from '../shared/mcgillApi';
import { readDownloadedItems, readRequiredAuthData, storageGet, storageSet, writeDownloadedItems } from '../shared/storage';
import type { MediaRecordingDto } from '../shared/types';

interface UiMediaItem {
  key: string;
  id: string;
  filename: string;
  recordingName: string;
  recordingTime: string;
  videoType: string;
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

interface StorageDebugState {
  RecordingsInfo: unknown;
  MediaRecordings: unknown;
  CoursesList: unknown;
  Cookies: unknown;
}

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

export function App() {
  const [courses, setCourses] = useState<UiCourse[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [debug, setDebug] = useState<StorageDebugState | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [helpOpen, setHelpOpen] = useState(true);

  const mediaByKey = useMemo(() => {
    const map = new Map<string, UiMediaItem>();
    courses.forEach((course) => {
      course.media.forEach((media) => {
        map.set(media.key, media);
      });
    });
    return map;
  }, [courses]);

  const persistDownloaded = useCallback(async (next: Set<string>) => {
    setDownloaded(new Set(next));
    await writeDownloadedItems(next);
  }, []);

  const buildCourse = useCallback(
    async (courseDigit: string, bearer: string, title: string | undefined, courseListId: string | null) => {
      const mediaList = await fetchCourseMediaList(courseDigit, bearer);
      if (mediaList.length === 0) {
        return null;
      }

      const media = mediaList.map((item, index) => {
        const filename = normalizeFilename(mediaList[0].courseName, index);
        return {
          key: `${courseDigit}::${item.id}::${filename}`,
          id: item.id,
          filename,
          recordingName: item.recordingName ?? 'Recording Name Unavailable',
          recordingTime: item.recordingTime,
          videoType: item.sources[0]?.label ?? 'VGA'
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
    setIsLoading(true);
    setErrorMessage('');

    try {
      const [downloadedItems, recordingsInfo, mediaRecordings, coursesListRaw, cookiesRaw] =
        await Promise.all([
          readDownloadedItems(),
          storageGet('RecordingsInfo'),
          storageGet('MediaRecordings'),
          storageGet('CoursesList'),
          storageGet('Cookies')
        ]);

      setDownloaded(downloadedItems);
      setDebug({
        RecordingsInfo: recordingsInfo ?? 'Not Found',
        MediaRecordings: mediaRecordings ?? 'Not Found',
        CoursesList: coursesListRaw ?? 'Not Found',
        Cookies: cookiesRaw ?? 'Not Found'
      });

      const authData = await readRequiredAuthData();
      setAuth(authData);

      const loadedCourses = new Map<string, UiCourse>();

      for (const courseListId of authData.coursesList) {
        try {
          const resolved = await resolveCourseDigit(authData.cookieHeader, courseListId);
          if (!resolved.courseDigit || loadedCourses.has(resolved.courseDigit)) {
            continue;
          }

          const course = await buildCourse(
            resolved.courseDigit,
            authData.bearer,
            resolved.contextTitle,
            courseListId
          );
          if (course) {
            loadedCourses.set(course.courseDigit, course);
          }
        } catch {
          // Keep parity with current behavior: skip failed course resolution and continue.
        }
      }

      const courseDigits = await storageGet('CoursesDigits');
      for (const courseDigit of courseDigits?.list ?? []) {
        if (loadedCourses.has(courseDigit)) {
          continue;
        }

        try {
          const fallbackCourse = await buildCourse(courseDigit, authData.bearer, undefined, null);
          if (fallbackCourse) {
            loadedCourses.set(courseDigit, fallbackCourse);
          }
        } catch {
          // Keep loading other courses.
        }
      }

      const courseList = Array.from(loadedCourses.values());
      setCourses(courseList);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      setCourses([]);
    } finally {
      setIsLoading(false);
    }
  }, [buildCourse]);

  useEffect(() => {
    void loadInitialState();
  }, [loadInitialState]);

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

  const setCourseSelection = (course: UiCourse, onlyNotDownloaded: boolean, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      course.media.forEach((item) => {
        if (onlyNotDownloaded && downloaded.has(item.filename)) {
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

  const toggleDownloadedStatus = async (filename: string) => {
    const next = new Set(downloaded);
    if (next.has(filename)) {
      next.delete(filename);
    } else {
      next.add(filename);
    }
    await persistDownloaded(next);
  };

  const removeCourse = async (course: UiCourse) => {
    const coursesList = (await storageGet('CoursesList'))?.coursesList ?? [];
    const coursesDigits = (await storageGet('CoursesDigits'))?.list ?? [];

    const nextList = course.courseListId ? coursesList.filter((item) => item !== course.courseListId) : coursesList;
    const nextDigits = coursesDigits.filter((item) => item !== course.courseDigit);

    await storageSet('CoursesList', { coursesList: nextList });
    await storageSet('CoursesDigits', { list: nextDigits });

    setCourses((previous) => previous.filter((item) => item.courseDigit !== course.courseDigit));
    setSelected((previous) => {
      const next = new Set(previous);
      course.media.forEach((media) => {
        next.delete(media.key);
      });
      return next;
    });
  };

  const handleDownload = async () => {
    if (isDownloading) {
      return;
    }
    if (!auth) {
      setErrorMessage('Missing auth/session data. Open myCourses and play a lecture, then reopen the extension.');
      return;
    }

    const chosen = Array.from(selected)
      .map((key) => mediaByKey.get(key))
      .filter((item): item is UiMediaItem => Boolean(item));

    if (chosen.length === 0) {
      setErrorMessage('No media selected.');
      return;
    }

    setErrorMessage('');
    setIsDownloading(true);

    const nextDownloaded = new Set(downloaded);
    const failures: string[] = [];

    for (let index = 0; index < chosen.length; index += 1) {
      const media = chosen[index];
      setStatusMessage(`Downloading ${index + 1}/${chosen.length}: ${media.filename}`);

      try {
        await downloadAndRemuxMedia({
          rid: media.id,
          fileName: media.filename,
          formatLabel: media.videoType,
          stoken: auth.stoken,
          etime: auth.etime,
          onProgress: (stage) => {
            setStatusMessage(`${stage} (${index + 1}/${chosen.length}): ${media.filename}`);
          }
        });

        nextDownloaded.add(media.filename);
        await writeDownloadedItems(nextDownloaded);
        setDownloaded(new Set(nextDownloaded));
      } catch (error) {
        failures.push(`${media.filename}: ${toErrorMessage(error)}`);
      }
    }

    setIsDownloading(false);
    setStatusMessage('');

    if (failures.length > 0) {
      setErrorMessage(`Some downloads failed:\n${failures.join('\n')}`);
    }
  };

  return (
    <main className="app-shell">
      <header className="top-bar">
        <h1 className="app-title">McGill Lectures Downloader</h1>
        <button className="help-button" onClick={() => setHelpOpen((value) => !value)} type="button">
          Help
        </button>
      </header>

      {helpOpen && (
        <section className="help-panel">
          <h2>Can&apos;t find your lectures?</h2>
          <ol>
            <li>Go to myCourses and login.</li>
            <li>Open the course you want to download.</li>
            <li>Start playing a lecture video.</li>
            <li>Click the extension icon again; the course should appear in the list.</li>
            <li>If it still does not appear, contact the developer.</li>
          </ol>
          <h3>Features</h3>
          <ul>
            <li>Batch download multiple videos at once. Do not close the tab while downloading.</li>
            <li>Downloaded videos are green. Right-click a video to toggle downloaded status.</li>
            <li>Right-click a course header to remove it from the list.</li>
          </ul>
        </section>
      )}

      {statusMessage && <p className="status-banner">{statusMessage}</p>}
      {errorMessage && <pre className="error-banner">{errorMessage}</pre>}

      <section className="debug-grid">
        {debug &&
          Object.entries(debug).map(([key, value]) => (
            <details key={key} className="debug-item">
              <summary>{key}</summary>
              <pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
            </details>
          ))}
      </section>

      <section className="course-list">
        {isLoading && <p className="empty-state">Loading courses...</p>}
        {!isLoading && courses.length === 0 && (
          <p className="empty-state">No courses found yet. Play a lecture from myCourses, then reopen this panel.</p>
        )}

        {courses.map((course) => {
          const selectedCount = course.media.filter((item) => selected.has(item.key)).length;
          const notDownloadedCount = course.media.filter((item) => !downloaded.has(item.filename)).length;
          const allSelected = selectedCount === course.media.length && course.media.length > 0;
          const notDownloadedSelected =
            notDownloadedCount > 0 &&
            course.media
              .filter((item) => !downloaded.has(item.filename))
              .every((item) => selected.has(item.key));

          return (
            <article key={course.courseDigit} className="course-card">
              <button
                type="button"
                className="course-header"
                onClick={() => toggleCourseExpansion(course.courseDigit)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void removeCourse(course);
                }}
              >
                <span>{course.title}</span>
                <span className="chevron">{course.expanded ? '▾' : '▸'}</span>
              </button>

              {course.expanded && (
                <div className="course-body">
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
                      const isDownloaded = downloaded.has(media.filename);
                      return (
                        <div
                          className={`media-item ${isDownloaded ? 'downloaded' : ''}`}
                          key={media.key}
                          onClick={() => toggleMediaSelection(media.key)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            void toggleDownloadedStatus(media.filename);
                          }}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              toggleMediaSelection(media.key);
                            }
                          }}
                        >
                          <div className="media-text">
                            <p>
                              <strong>Recording Name:</strong> {media.recordingName}
                            </p>
                            <p>
                              <strong>Recording Time:</strong> {media.recordingTime}
                            </p>
                            <p>
                              <strong>Download File Name:</strong> {media.filename}
                            </p>
                          </div>
                          <input
                            type="checkbox"
                            checked={selected.has(media.key)}
                            onChange={() => toggleMediaSelection(media.key)}
                            onClick={(event) => event.stopPropagation()}
                          />
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

      <footer className="bottom-bar">
        <button type="button" className="download-button" onClick={() => void handleDownload()} disabled={isDownloading}>
          {isDownloading ? 'Downloading...' : 'Download'}
        </button>
      </footer>
    </main>
  );
}
