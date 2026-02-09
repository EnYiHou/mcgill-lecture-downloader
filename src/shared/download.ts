import { remuxTsToMp4, type RemuxCaptionTrack } from './ffmpeg';
import type { DownloadMediaInput } from './types';

function buildTsMediaUrl(params: Record<string, string>): string {
  return `https://lrscdn.mcgill.ca/api/tsmedia/?${new URLSearchParams(params).toString()}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Download cancelled by user', 'AbortError');
  }
}

async function getTsMediaSize(
  params: Record<string, string>,
  retries = 10,
  signal?: AbortSignal
): Promise<number> {
  throwIfAborted(signal);
  const response = await fetch(buildTsMediaUrl(params), { signal });

  if (!response.ok) {
    if (retries > 0) {
      return getTsMediaSize(params, retries - 1, signal);
    }
    throw new Error(`Failed to detect media size: ${response.status}`);
  }

  const contentRange = response.headers.get('Content-Range');
  if (!contentRange?.includes('/')) {
    throw new Error('Missing Content-Range header from tsmedia response');
  }

  return Number.parseInt(contentRange.split('/')[1], 10);
}

export interface DetectMediaSizeInput {
  rid: string;
  formatLabel?: string;
  stoken: string;
  etime: string;
  signal?: AbortSignal;
}

export async function detectMediaSizeBytes({
  rid,
  formatLabel = 'VGA',
  stoken,
  etime,
  signal
}: DetectMediaSizeInput): Promise<number> {
  return getTsMediaSize({ f: formatLabel, rid, stoken, etime }, 2, signal);
}

function resolveCaptionCandidates(captionSrc: string): string[] {
  const trimmed = captionSrc.trim();
  if (!trimmed) {
    return [];
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return [trimmed];
  }

  const normalizedPath = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const candidates = [
    new URL(normalizedPath, 'https://lrs.mcgill.ca/').toString(),
    new URL(normalizedPath, 'https://lrswapi.campus.mcgill.ca/api/').toString()
  ];

  return Array.from(new Set(candidates));
}

async function fetchCaptionTrack(
  captionSrc: string,
  captionLanguage: string | null | undefined,
  bearerToken: string | undefined,
  signal?: AbortSignal
): Promise<RemuxCaptionTrack> {
  const candidates = resolveCaptionCandidates(captionSrc);
  if (candidates.length === 0) {
    throw new Error('No caption URL provided.');
  }

  let lastError: Error | null = null;

  for (const url of candidates) {
    const headersOptions: Array<Record<string, string> | undefined> = bearerToken
      ? [{ Authorization: bearerToken }, undefined]
      : [undefined];

    for (const headers of headersOptions) {
      throwIfAborted(signal);
      try {
        const response = await fetch(url, {
          signal,
          headers,
          credentials: 'include'
        });

        if (!response.ok) {
          lastError = new Error(`Caption request failed: ${response.status} (${url})`);
          continue;
        }

        const raw = await response.text();
        const content = raw.trim();
        if (!content) {
          lastError = new Error(`Caption file was empty (${url}).`);
          continue;
        }

        return {
          content: content.startsWith('WEBVTT') ? raw : `WEBVTT\n\n${raw}`,
          language: captionLanguage ?? 'en'
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  throw lastError ?? new Error('Unable to fetch captions for this recording.');
}

export function saveBlobDownload(blob: Blob, fileName: string): void {
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function downloadAndRemuxMedia({
  rid,
  fileName,
  formatLabel = 'VGA',
  stoken,
  etime,
  bearerToken,
  captionSrc,
  captionLanguage,
  embedCaptions = true,
  onProgress,
  signal
}: DownloadMediaInput): Promise<void> {
  const params = { f: formatLabel, rid, stoken, etime };

  throwIfAborted(signal);
  onProgress?.('Fetching media metadata');
  const totalBytes = await getTsMediaSize(params, 10, signal);

  throwIfAborted(signal);
  onProgress?.('Downloading TS stream');
  const response = await fetch(buildTsMediaUrl(params), {
    signal,
    headers: {
      Range: `bytes=0-${totalBytes - 1}`
    }
  });

  if (response.status !== 206) {
    throw new Error(`Expected partial content (206), got ${response.status}`);
  }

  const tsBlob = await response.blob();

  let captionTrack: RemuxCaptionTrack | null = null;
  if (embedCaptions && captionSrc) {
    throwIfAborted(signal);
    onProgress?.('Downloading captions');
    try {
      captionTrack = await fetchCaptionTrack(captionSrc, captionLanguage, bearerToken, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      onProgress?.('Captions unavailable, continuing without captions');
    }
  }

  throwIfAborted(signal);
  onProgress?.('Remuxing to MP4');
  const outputName = `${fileName}.mp4`;
  let mp4Blob: Blob;

  try {
    mp4Blob = await remuxTsToMp4(tsBlob, outputName, captionTrack);
  } catch (error) {
    if (!captionTrack) {
      throw error;
    }
    throwIfAborted(signal);
    onProgress?.('Caption embed failed, remuxing without captions');
    mp4Blob = await remuxTsToMp4(tsBlob, outputName);
  }

  throwIfAborted(signal);
  onProgress?.('Saving file');
  saveBlobDownload(mp4Blob, outputName);
}
