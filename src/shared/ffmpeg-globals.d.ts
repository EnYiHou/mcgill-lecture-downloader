interface FFmpegNamespace {
  createFFmpeg: (opts: {
    corePath: string;
    mainName?: string;
    log?: boolean;
  }) => {
    isLoaded: () => boolean;
    load: () => Promise<void>;
    FS: (method: string, path: string, data?: Uint8Array) => Uint8Array;
    run: (...args: string[]) => Promise<void>;
  };
  fetchFile: (input: Blob | string) => Promise<Uint8Array>;
}

declare const FFmpeg: FFmpegNamespace;
