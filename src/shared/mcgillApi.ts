import type { MediaRecordingDto } from './types';

export function extractPayload(html: string): Record<string, string> {
  const inputFields: Record<string, string> = {};
  const inputRegex = /<input type="(hidden|submit)" name="([^"]+)" value="([^"]*)">/g;
  let match: RegExpExecArray | null;

  while ((match = inputRegex.exec(html)) !== null) {
    inputFields[match[2]] = match[3];
  }

  return inputFields;
}

export function extractHfCourseId(html: string): string | null {
  const courseIdRegex =
    /<input type="hidden" name="HF_CourseID" id="HF_CourseID" value="([^"]*)"\s*\/>/;
  const match = courseIdRegex.exec(html);
  return match?.[1] ?? null;
}

export async function fetchLtiPayload(cookieHeader: string, courseListId: string): Promise<Record<string, string>> {
  const url = `https://mycourses2.mcgill.ca/d2l/le/lti/${courseListId}/toolLaunch/3/1579761452?fullscreen=1&d2l_body_type=3`;

  const response = await fetch(url, {
    headers: {
      cookie: cookieHeader
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch LTI payload: ${response.status}`);
  }

  const html = await response.text();
  return extractPayload(html);
}

export async function fetchCourseLandingHtml(payload: Record<string, string>): Promise<string> {
  const response = await fetch('https://lrs.mcgill.ca/listrecordings.aspx', {
    method: 'POST',
    body: new URLSearchParams(payload)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch lrs listrecordings page: ${response.status}`);
  }

  return response.text();
}

export async function resolveCourseDigit(
  cookieHeader: string,
  courseListId: string
): Promise<{ courseDigit: string | null; contextTitle: string | undefined }> {
  const payload = await fetchLtiPayload(cookieHeader, courseListId);
  const html = await fetchCourseLandingHtml(payload);
  const courseDigit = extractHfCourseId(html);

  return {
    courseDigit,
    contextTitle: payload.context_title
  };
}

export async function fetchCourseMediaList(
  courseDigit: string,
  bearerToken: string
): Promise<MediaRecordingDto[]> {
  const url = `https://lrswapi.campus.mcgill.ca/api/MediaRecordings/dto/${courseDigit}`;
  const response = await fetch(url, {
    headers: {
      Authorization: bearerToken
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch media list for ${courseDigit}: ${response.status}`);
  }

  return (await response.json()) as MediaRecordingDto[];
}
