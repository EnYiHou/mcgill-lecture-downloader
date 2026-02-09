interface FFmpegCoreFsApi {
  writeFile: (path: string, data: Uint8Array) => void;
  readFile: (path: string) => Uint8Array;
  unlink: (path: string) => void;
}

interface FFmpegCoreModule {
  FS: FFmpegCoreFsApi;
  _main: (argc: number, argv: number) => number;
  callMain?: (args: string[]) => void;
  _malloc: (size: number) => number;
  lengthBytesUTF8: (value: string) => number;
  stringToUTF8: (value: string, outPtr: number, maxBytesToWrite: number) => void;
  setValue: (ptr: number, value: number, type: string) => void;
}

interface FFmpegCoreOptions {
  mainScriptUrlOrBlob: string;
  locateFile: (path: string, prefix: string) => string;
  print?: (message: string) => void;
  printErr?: (message: string) => void;
}

declare function createFFmpegCore(options: FFmpegCoreOptions): Promise<FFmpegCoreModule>;
