let ffmpegInstance: ReturnType<FFmpegNamespace['createFFmpeg']> | null = null;

export async function ensureFfmpegLoaded(): Promise<ReturnType<FFmpegNamespace['createFFmpeg']>> {
  if (!ffmpegInstance) {
    ffmpegInstance = FFmpeg.createFFmpeg({
      corePath: chrome.runtime.getURL('lib/ffmpeg-core.js'),
      log: false,
      mainName: 'main'
    });
  }

  if (!ffmpegInstance.isLoaded()) {
    await ffmpegInstance.load();
  }

  return ffmpegInstance;
}

export async function remuxTsToMp4(tsBlob: Blob, outputFileName: string): Promise<Blob> {
  const ffmpeg = await ensureFfmpegLoaded();
  const inputFileName = 'input.ts';

  const data = new Uint8Array(await tsBlob.arrayBuffer());
  ffmpeg.FS('writeFile', inputFileName, data);

  await ffmpeg.run('-y', '-i', inputFileName, '-c', 'copy', outputFileName);

  const result = ffmpeg.FS('readFile', outputFileName);

  try {
    ffmpeg.FS('unlink', inputFileName);
  } catch {
    // No-op cleanup.
  }

  try {
    ffmpeg.FS('unlink', outputFileName);
  } catch {
    // No-op cleanup.
  }

  const output = new Uint8Array(result.byteLength);
  output.set(result);

  return new Blob([output.buffer], { type: 'video/mp4' });
}
