let ffmpegCore: FFmpegCoreModule | null = null;
let running = false;
let stderrBuffer: string[] = [];
let ffmpegScriptLoading: Promise<void> | null = null;
const DEBUG_PREFIX = '[McLecture][ffmpeg]';
const FFMPEG_FATAL_PATTERNS = [
  'conversion failed',
  'error initializing output stream',
  'invalid data found when processing input',
  'could not write header',
  'no streams to mux were specified'
];

export interface RemuxCaptionTrack {
  content: string;
  language?: string | null;
}

export interface RemuxResult {
  blob: Blob;
  captionsEmbedded: boolean;
  debugLog: string[];
}

function debugInfo(message: string): void {
  console.info(`${DEBUG_PREFIX} ${message}`);
}

function stderrTail(maxLines = 12): string {
  if (stderrBuffer.length === 0) {
    return '';
  }
  return stderrBuffer.slice(-maxLines).join(' | ');
}

function normalizeTimestamp(value: string): string | null {
  const trimmed = value.trim().replace(',', '.');
  const main = trimmed.split(/[ \t]/)[0];
  const match = main.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) {
    return null;
  }
  const hours = (match[1] ?? '0').padStart(2, '0');
  const minutes = match[2].padStart(2, '0');
  const seconds = match[3].padStart(2, '0');
  const millis = (match[4] ?? '0').padEnd(3, '0').slice(0, 3);
  return `${hours}:${minutes}:${seconds},${millis}`;
}

function parseSrtTimestampToMillis(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) {
    return null;
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const millis = Number.parseInt(match[4], 10);
  return (((hours * 60 + minutes) * 60 + seconds) * 1000) + millis;
}

function formatMillisAsSrtTimestamp(totalMillis: number): string {
  const clamped = Math.max(0, Math.floor(totalMillis));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${millis.toString().padStart(3, '0')}`;
}

function convertWebVttToSrt(content: string): string | null {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) {
    return null;
  }

  const lines = normalized.split('\n');
  const blocks: string[] = [];
  const current: string[] = [];

  for (const line of lines) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
        current.length = 0;
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }

  const cues: string[] = [];
  let cueIndex = 1;
  let lastEndMs = 0;

  for (const rawBlock of blocks) {
    const blockLines = rawBlock
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);

    if (blockLines.length === 0) {
      continue;
    }

    if (blockLines[0].toUpperCase() === 'WEBVTT') {
      continue;
    }
    if (
      blockLines[0].startsWith('NOTE') ||
      blockLines[0].startsWith('STYLE') ||
      blockLines[0].startsWith('REGION') ||
      blockLines[0].startsWith('X-TIMESTAMP-MAP')
    ) {
      continue;
    }

    const timeLineIndex = blockLines.findIndex((line) => line.includes('-->'));
    if (timeLineIndex < 0) {
      continue;
    }

    const timeLine = blockLines[timeLineIndex];
    const [startRaw, endRaw] = timeLine.split('-->');
    if (!startRaw || !endRaw) {
      continue;
    }

    const start = normalizeTimestamp(startRaw);
    const end = normalizeTimestamp(endRaw);
    if (!start || !end) {
      continue;
    }

    let startMs = parseSrtTimestampToMillis(start);
    let endMs = parseSrtTimestampToMillis(end);
    if (startMs === null || endMs === null) {
      continue;
    }
    if (startMs < lastEndMs) {
      startMs = lastEndMs;
    }
    if (endMs <= startMs) {
      endMs = startMs + 200;
    }
    lastEndMs = endMs;

    const textLines = blockLines.slice(timeLineIndex + 1).filter((line) => line.trim().length > 0);
    if (textLines.length === 0) {
      continue;
    }

    cues.push(`${cueIndex}`);
    cues.push(`${formatMillisAsSrtTimestamp(startMs)} --> ${formatMillisAsSrtTimestamp(endMs)}`);
    cues.push(...textLines);
    cues.push('');
    cueIndex += 1;
  }

  const result = cues.join('\n').trim();
  return result.length > 0 ? `${result}\n` : null;
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
    debugInfo(`run: ffmpeg -nostdin -y ${args.join(' ')}`);
    if (typeof module.callMain === 'function') {
      const maybeExitCode = module.callMain(['-nostdin', '-y', ...args]);
      if (typeof maybeExitCode === 'number' && maybeExitCode !== 0) {
        const stderr = stderrBuffer.join('\n').trim();
        throw new Error(
          stderr.length > 0
            ? `FFmpeg exited with status ${maybeExitCode}: ${stderr}`
            : `FFmpeg exited with status ${maybeExitCode}.`
        );
      }
      const stderr = stderrBuffer.join('\n').toLowerCase();
      if (FFMPEG_FATAL_PATTERNS.some((pattern) => stderr.includes(pattern))) {
        debugInfo(`fatal stderr: ${stderrBuffer.slice(-20).join(' | ')}`);
        throw new Error(`FFmpeg failed: ${stderrBuffer.join('\n').trim()}`);
      }
      const tail = stderrTail();
      if (tail) {
        debugInfo(`stderr tail: ${tail}`);
      }
      return;
    }

    const ffmpegArgs = ['./ffmpeg', '-nostdin', '-y', ...args].filter((value) => value.length > 0);
    const [argc, argv] = parseArgs(module, ffmpegArgs);
    const status = module._main(argc, argv);
    if (typeof status === 'number' && status !== 0) {
      const stderr = stderrBuffer.join('\n').trim();
      throw new Error(stderr.length > 0 ? `FFmpeg exited with status ${status}: ${stderr}` : `FFmpeg exited with status ${status}.`);
    }
    const tail = stderrTail();
    if (tail) {
      debugInfo(`stderr tail: ${tail}`);
    }
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

    debugInfo(`command error stderr tail: ${stderrTail(20)}`);
    try {
      throw new Error(JSON.stringify(error));
    } catch {
      throw new Error(String(error));
    }
  } finally {
    running = false;
  }
}

async function hasPlayableMediaStream(fileName: string): Promise<boolean> {
  try {
    // Confirm the file still has at least one video/audio stream.
    await runFfmpegCommand([
      '-i',
      fileName,
      '-map',
      '0:v?',
      '-map',
      '0:a?',
      '-c',
      'copy',
      '-f',
      'null',
      '-'
    ]);
    return true;
  } catch {
    return false;
  }
}

async function hasSubtitleStream(fileName: string): Promise<boolean> {
  try {
    await runFfmpegCommand(['-i', fileName, '-map', '0:s:0', '-c', 'copy', '-f', 'null', '-']);
    return true;
  } catch {
    return false;
  }
}

async function hasDecodableMediaStream(fileName: string): Promise<boolean> {
  try {
    await runFfmpegCommand([
      '-v',
      'error',
      '-xerror',
      '-i',
      fileName,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-t',
      '5',
      '-f',
      'null',
      '-'
    ]);
    return true;
  } catch {
    return false;
  }
}

function removeFsFile(module: FFmpegCoreModule, fileName: string): void {
  try {
    module.FS.unlink(fileName);
  } catch {
    // No-op cleanup.
  }
}

function assertFsFileExists(module: FFmpegCoreModule, fileName: string): void {
  try {
    const data = module.FS.readFile(fileName);
    if (!data || data.byteLength === 0) {
      throw new Error(`FFmpeg output file is empty: ${fileName}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`FFmpeg output file was not generated: ${fileName}`);
  }
}

export async function remuxTsToMp4(
  tsBlob: Blob,
  outputFileName: string,
  captionTrack?: RemuxCaptionTrack | null
): Promise<RemuxResult> {
  const debugLog: string[] = [];
  const pushDebug = (message: string): void => {
    debugLog.push(message);
    debugInfo(message);
  };
  const module = await ensureFfmpegLoaded();
  const jobId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inputFileName = `input-${jobId}.ts`;
  const baseOutputFileName = `base-output-${jobId}.mp4`;
  const captionOutputFileName = `caption-output-${jobId}.mp4`;
  const subtitleTrackOutputFileName = `subtitle-track-${jobId}.mp4`;
  const finalOutputFileName = `final-output-${jobId}.mp4`;
  const captionContent = captionTrack?.content ?? '';
  const captionFileName = captionContent ? `captions-${jobId}.vtt` : null;
  const captionSrtFileName = captionContent ? `captions-${jobId}.srt` : null;
  let captionsEmbedded = false;
  pushDebug(`start remux output=${outputFileName} tsBytes=${tsBlob.size} caption=${Boolean(captionTrack?.content)}`);

  // Clean up stale files if any were left behind by a failed prior run.
  removeFsFile(module, inputFileName);
  removeFsFile(module, baseOutputFileName);
  removeFsFile(module, captionOutputFileName);
  removeFsFile(module, subtitleTrackOutputFileName);
  removeFsFile(module, finalOutputFileName);
  if (captionFileName) {
    removeFsFile(module, captionFileName);
  }
  if (captionSrtFileName) {
    removeFsFile(module, captionSrtFileName);
  }

  const data = new Uint8Array(await tsBlob.arrayBuffer());
  module.FS.writeFile(inputFileName, data);

  if (captionFileName) {
    const captionData = new TextEncoder().encode(captionContent);
    module.FS.writeFile(captionFileName, captionData);
    pushDebug(`caption VTT bytes=${captionData.byteLength}`);
    const srt = convertWebVttToSrt(captionContent);
    if (srt && captionSrtFileName) {
      const srtData = new TextEncoder().encode(srt);
      module.FS.writeFile(captionSrtFileName, srtData);
      pushDebug(`caption SRT bytes=${srtData.byteLength}`);
    } else {
      pushDebug('caption SRT conversion unavailable');
    }
  }

  // First produce a baseline MP4 from the transport stream.
  await runFfmpegCommand([
    '-i',
    inputFileName,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-bsf:a',
    'aac_adtstoasc',
    baseOutputFileName
  ]);
  assertFsFileExists(module, baseOutputFileName);
  if (!(await hasPlayableMediaStream(baseOutputFileName)) || !(await hasDecodableMediaStream(baseOutputFileName))) {
    pushDebug('base mp4 copy remux produced non-decodable stream; retrying with re-encode');
    let reencodeOk = false;
    try {
      await runFfmpegCommand([
        '-i',
        inputFileName,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        baseOutputFileName
      ]);
      reencodeOk = true;
      pushDebug('base mp4 re-encode succeeded with libx264/aac');
    } catch {
      reencodeOk = false;
      pushDebug(`base mp4 re-encode failed with libx264/aac: ${stderrTail(20)}`);
    }

    if (!reencodeOk) {
      await runFfmpegCommand([
        '-i',
        inputFileName,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'mpeg4',
        '-q:v',
        '3',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        baseOutputFileName
      ]);
      pushDebug('base mp4 re-encode succeeded with mpeg4/aac');
    }
  }

  if (!(await hasPlayableMediaStream(baseOutputFileName)) || !(await hasDecodableMediaStream(baseOutputFileName))) {
    throw new Error('Base MP4 remux did not produce a decodable video/audio stream.');
  }
  pushDebug('base mp4 remux succeeded');

  if (captionFileName) {
    const language = (captionTrack?.language ?? 'en').trim() || 'en';
    let subtitleTrackReady = false;

    try {
      await runFfmpegCommand([
        '-f',
        'webvtt',
        '-i',
        captionFileName,
        '-map',
        '0:0',
        '-c:s',
        'mov_text',
        '-f',
        'mp4',
        subtitleTrackOutputFileName
      ]);
      assertFsFileExists(module, subtitleTrackOutputFileName);
      subtitleTrackReady = await hasSubtitleStream(subtitleTrackOutputFileName);
      pushDebug(
        subtitleTrackReady
          ? 'subtitle track build succeeded with webvtt input'
          : 'subtitle track build missing subtitle stream with webvtt input'
      );
    } catch {
      subtitleTrackReady = false;
      pushDebug(`subtitle track build failed with webvtt input: ${stderrTail(20)}`);
    }

    if (!subtitleTrackReady && captionSrtFileName) {
      try {
        await runFfmpegCommand([
          '-f',
          'srt',
          '-i',
          captionSrtFileName,
          '-map',
          '0:0',
          '-c:s',
          'mov_text',
          '-f',
          'mp4',
          subtitleTrackOutputFileName
        ]);
        assertFsFileExists(module, subtitleTrackOutputFileName);
        subtitleTrackReady = await hasSubtitleStream(subtitleTrackOutputFileName);
        pushDebug(
          subtitleTrackReady
            ? 'subtitle track build succeeded with srt input'
            : 'subtitle track build missing subtitle stream with srt input'
        );
      } catch {
        subtitleTrackReady = false;
        pushDebug(`subtitle track build failed with srt input: ${stderrTail(20)}`);
      }
    }

    let captionEmbedded = false;
    if (subtitleTrackReady) {
      await runFfmpegCommand([
        '-i',
        baseOutputFileName,
        '-i',
        subtitleTrackOutputFileName,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-map',
        '1:s:0',
        '-c:v',
        'copy',
        '-c:a',
        'copy',
        '-c:s',
        'copy',
        '-metadata:s:s:0',
        `language=${language}`,
        captionOutputFileName
      ]);
      assertFsFileExists(module, captionOutputFileName);
      captionEmbedded =
        (await hasPlayableMediaStream(captionOutputFileName)) &&
        (await hasSubtitleStream(captionOutputFileName)) &&
        (await hasDecodableMediaStream(captionOutputFileName));
      if (!captionEmbedded) {
        pushDebug('caption mux copy path produced non-decodable media; retrying with re-encode');
        let muxReencodeOk = false;
        try {
          await runFfmpegCommand([
            '-i',
            baseOutputFileName,
            '-i',
            subtitleTrackOutputFileName,
            '-map',
            '0:v:0',
            '-map',
            '0:a?',
            '-map',
            '1:s:0',
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-c:s',
            'copy',
            '-metadata:s:s:0',
            `language=${language}`,
            captionOutputFileName
          ]);
          muxReencodeOk = true;
          pushDebug('caption mux re-encode succeeded with libx264/aac');
        } catch {
          muxReencodeOk = false;
          pushDebug(`caption mux re-encode failed with libx264/aac: ${stderrTail(20)}`);
        }
        if (!muxReencodeOk) {
          await runFfmpegCommand([
            '-i',
            baseOutputFileName,
            '-i',
            subtitleTrackOutputFileName,
            '-map',
            '0:v:0',
            '-map',
            '0:a?',
            '-map',
            '1:s:0',
            '-c:v',
            'mpeg4',
            '-q:v',
            '3',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-c:s',
            'copy',
            '-metadata:s:s:0',
            `language=${language}`,
            captionOutputFileName
          ]);
          pushDebug('caption mux re-encode succeeded with mpeg4/aac');
        }

        captionEmbedded =
          (await hasPlayableMediaStream(captionOutputFileName)) &&
          (await hasSubtitleStream(captionOutputFileName)) &&
          (await hasDecodableMediaStream(captionOutputFileName));
      }
      pushDebug(
        captionEmbedded
          ? 'caption mux succeeded with base media + subtitle track'
          : 'caption mux output missing required streams'
      );
    }

    if (captionEmbedded) {
      captionsEmbedded = true;
      pushDebug('final output selected from caption output');
    } else {
      throw new Error(`Caption embedding failed. ${debugLog.slice(-20).join(' | ')}`);
    }
  } else {
    await runFfmpegCommand(['-i', baseOutputFileName, '-map', '0', '-c', 'copy', finalOutputFileName]);
    pushDebug('final copy used base output (no caption track provided)');
  }
  const selectedOutput = captionsEmbedded ? captionOutputFileName : finalOutputFileName;
  assertFsFileExists(module, selectedOutput);
  pushDebug('final output exists');

  let result: Uint8Array;
  try {
    result = module.FS.readFile(selectedOutput);
  } catch {
    throw new Error('FFmpeg output file was not generated.');
  }

  removeFsFile(module, inputFileName);
  removeFsFile(module, baseOutputFileName);
  removeFsFile(module, captionOutputFileName);
  removeFsFile(module, subtitleTrackOutputFileName);
  removeFsFile(module, finalOutputFileName);

  if (captionFileName) {
    removeFsFile(module, captionFileName);
  }
  if (captionSrtFileName) {
    removeFsFile(module, captionSrtFileName);
  }

  const output = new Uint8Array(result.byteLength);
  output.set(result);

  return {
    blob: new Blob([output.buffer], { type: 'video/mp4' }),
    captionsEmbedded,
    debugLog
  };
}
