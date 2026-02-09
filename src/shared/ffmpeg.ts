let ffmpegCore: FFmpegCoreModule | null = null;
let running = false;
let stderrBuffer: string[] = [];
let ffmpegScriptLoading: Promise<void> | null = null;

export interface RemuxCaptionTrack {
  content: string;
  language?: string | null;
}

function parseArgs(module: FFmpegCoreModule, args: string[]): [number, number] {
  const argc = args.length;
  const argv = module._malloc(argc * Uint32Array.BYTES_PER_ELEMENT);

  args.forEach((arg, index) => {
    const size = module.lengthBytesUTF8(arg) + 1;
    const ptr = module._malloc(size);
    module.stringToUTF8(arg, ptr, size);
    module.setValue(argv + Uint32Array.BYTES_PER_ELEMENT * index, ptr, 'i32');
  });

  return [argc, argv];
}

export async function ensureFfmpegLoaded(): Promise<FFmpegCoreModule> {
  if (ffmpegCore) {
    return ffmpegCore;
  }

  if (typeof createFFmpegCore !== 'function') {
    if (!ffmpegScriptLoading) {
      ffmpegScriptLoading = new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('lib/ffmpeg-core.js');
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load FFmpeg core script.'));
        document.head.append(script);
      });
    }
    await ffmpegScriptLoading;
  }

  const coreUrl = chrome.runtime.getURL('lib/ffmpeg-core.js');
  const wasmUrl = chrome.runtime.getURL('lib/ffmpeg-core.wasm');
  const workerUrl = chrome.runtime.getURL('lib/ffmpeg-core.worker.js');

  ffmpegCore = await createFFmpegCore({
    mainScriptUrlOrBlob: coreUrl,
    locateFile: (path, prefix) => {
      if (path.endsWith('ffmpeg-core.wasm')) {
        return wasmUrl;
      }
      if (path.endsWith('ffmpeg-core.worker.js')) {
        return workerUrl;
      }
      return `${prefix}${path}`;
    },
    print: (message) => {
      void message;
    },
    printErr: (message) => {
      stderrBuffer.push(message);
    }
  });
  return ffmpegCore;
}

async function runFfmpegCommand(args: string[]): Promise<void> {
  const module = await ensureFfmpegLoaded();
  if (running) {
    throw new Error('FFmpeg is busy, try again after the current operation completes.');
  }

  running = true;
  stderrBuffer = [];

  try {
    if (typeof module.callMain === 'function') {
      module.callMain(['-nostdin', '-y', ...args]);
      return;
    }

    const ffmpegArgs = ['./ffmpeg', '-nostdin', '-y', ...args].filter((value) => value.length > 0);
    const [argc, argv] = parseArgs(module, ffmpegArgs);
    module._main(argc, argv);
  } catch (error) {
    const maybeStatus =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : null;

    if (maybeStatus === 0) {
      return;
    }

    if (error instanceof Error) {
      throw error;
    }

    if (maybeStatus !== null) {
      const stderr = stderrBuffer.join('\n').trim();
      throw new Error(
        stderr.length > 0
          ? `FFmpeg exited with status ${maybeStatus}: ${stderr}`
          : `FFmpeg exited with status ${maybeStatus}.`
      );
    }

    try {
      throw new Error(JSON.stringify(error));
    } catch {
      throw new Error(String(error));
    }
  } finally {
    running = false;
  }
}

export async function remuxTsToMp4(
  tsBlob: Blob,
  outputFileName: string,
  captionTrack?: RemuxCaptionTrack | null
): Promise<Blob> {
  const module = await ensureFfmpegLoaded();
  const inputFileName = 'input.ts';
  const captionContent = captionTrack?.content ?? '';
  const captionFileName = captionContent ? 'captions.vtt' : null;

  const data = new Uint8Array(await tsBlob.arrayBuffer());
  module.FS.writeFile(inputFileName, data);

  if (captionFileName) {
    const captionData = new TextEncoder().encode(captionContent);
    module.FS.writeFile(captionFileName, captionData);
  }

  if (captionFileName) {
    const language = (captionTrack?.language ?? 'en').trim() || 'en';
    await runFfmpegCommand([
      '-i',
      inputFileName,
      '-i',
      captionFileName,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-map',
      '1:0',
      '-c',
      'copy',
      '-c:s',
      'mov_text',
      '-metadata:s:s:0',
      `language=${language}`,
      outputFileName
    ]);
  } else {
    await runFfmpegCommand(['-i', inputFileName, '-c', 'copy', outputFileName]);
  }

  let result: Uint8Array;
  try {
    result = module.FS.readFile(outputFileName);
  } catch {
    throw new Error('FFmpeg output file was not generated.');
  }

  try {
    module.FS.unlink(inputFileName);
  } catch {
    // No-op cleanup.
  }

  if (captionFileName) {
    try {
      module.FS.unlink(captionFileName);
    } catch {
      // No-op cleanup.
    }
  }

  try {
    module.FS.unlink(outputFileName);
  } catch {
    // No-op cleanup.
  }

  const output = new Uint8Array(result.byteLength);
  output.set(result);

  return new Blob([output.buffer], { type: 'video/mp4' });
}
