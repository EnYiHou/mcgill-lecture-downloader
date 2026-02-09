import { remuxTsToMp4 } from './ffmpeg';
import type { DownloadMediaInput } from './types';

function buildTsMediaUrl(params: Record<string, string>): string {
  return `https://lrscdn.mcgill.ca/api/tsmedia/?${new URLSearchParams(params).toString()}`;
}

async function getTsMediaSize(params: Record<string, string>, retries = 10): Promise<number> {
  const response = await fetch(buildTsMediaUrl(params));

  if (!response.ok) {
    if (retries > 0) {
      return getTsMediaSize(params, retries - 1);
    }
    throw new Error(`Failed to detect media size: ${response.status}`);
  }

  const contentRange = response.headers.get('Content-Range');
  if (!contentRange?.includes('/')) {
    throw new Error('Missing Content-Range header from tsmedia response');
  }

  return Number.parseInt(contentRange.split('/')[1], 10);
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
  onProgress
}: DownloadMediaInput): Promise<void> {
  const params = { f: formatLabel, rid, stoken, etime };

  onProgress?.('Fetching media metadata');
  const totalBytes = await getTsMediaSize(params);

  onProgress?.('Downloading TS stream');
  const response = await fetch(buildTsMediaUrl(params), {
    headers: {
      Range: `bytes=0-${totalBytes - 1}`
    }
  });

  if (response.status !== 206) {
    throw new Error(`Expected partial content (206), got ${response.status}`);
  }

  const tsBlob = await response.blob();

  onProgress?.('Remuxing to MP4');
  const outputName = `${fileName}.mp4`;
  const mp4Blob = await remuxTsToMp4(tsBlob, outputName);

  onProgress?.('Saving file');
  saveBlobDownload(mp4Blob, outputName);
}
