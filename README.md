# McGill Lecture Downloader

Chrome extension (Manifest V3) for downloading McGill myCourses lecture recordings and remuxing TS streams to MP4 with FFmpeg WASM.

## Development setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. Optional checks:
   ```bash
   npm run test
   npm run typecheck
   npm run lint
   ```

## Build output

- Build artifacts are generated in `dist/`.
- `dist/` includes:
  - `manifest.json`
  - `js/background.js`
  - `js/content.js`
  - `popup.html`
  - bundled UI assets under `assets/` and `css/`
  - FFmpeg files under `lib/`

## Load unpacked extension

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `dist/` folder.

## User workflow

1. Open [myCourses](https://mycourses2.mcgill.ca), log in, and play at least one lecture.
2. Open a myCourses tab and click the extension action icon to inject the draggable overlay.
3. In the overlay UI:
   - expand a course
   - select videos
   - click **Download**
4. Downloads are remuxed to `.mp4` and saved by the browser.

## Troubleshooting

- Missing courses/tokens:
  - Play a lecture first, then click the extension icon again.
  - The extension depends on captured headers/cookies stored in `chrome.storage.local`.
- Permissions or request capture issues:
  - Ensure host permissions are granted and extension is enabled.
  - The overlay can be opened from any normal webpage tab; restricted Chrome internal pages are still blocked by Chrome.
- FFmpeg loading errors:
  - Confirm `dist/lib/ffmpeg-core.js`, `dist/lib/ffmpeg-core.wasm`, and `dist/lib/ffmpeg-core.worker.js` exist.
  - The UI resolves FFmpeg core via `chrome.runtime.getURL(...)`.
- CSP errors:
  - The extension uses local bundled assets only (no remote JS/CSS CDNs).
- Downloads fail or stall:
  - Keep the source tab open while downloading.
  - Retry if network/API requests return non-206 responses.
