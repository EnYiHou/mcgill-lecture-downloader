<p align="center">
  <img src="./assets/logo.png" width="112" alt="McLecture logo">
</p>

<h1 align="center">McLecture</h1>

<p align="center">
  <strong>A Chrome extension for saving McGill myCourses lecture recordings as local MP4 files.</strong>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/mclecture/ipnhkfogmlokecmpgjhdkkibomgbjmlb">
    <img alt="Chrome Web Store" src="https://img.shields.io/badge/Chrome%20Web%20Store-McLecture-9f1230?style=for-the-badge&logo=googlechrome&logoColor=white">
  </a>
  <a href="https://github.com/EnYiHou/mclecture/blob/main/LICENSE">
    <img alt="License" src="https://img.shields.io/github/license/EnYiHou/mclecture?style=for-the-badge&color=7f1d1d">
  </a>
  <a href="https://github.com/EnYiHou/mclecture">
    <img alt="Manifest version" src="https://img.shields.io/badge/manifest-v2.0.12-b91c1c?style=for-the-badge">
  </a>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/mclecture/ipnhkfogmlokecmpgjhdkkibomgbjmlb">Chrome Web Store</a>
  ·
  <a href="https://github.com/EnYiHou/mclecture/issues">Report an issue</a>
</p>

## Overview

McLecture adds a lightweight overlay to McGill myCourses pages so students can discover available lecture recordings, choose formats, queue multiple downloads, and save recordings locally as `.mp4` files.

The extension is built for a simple workflow: open myCourses, play a lecture once so the required Brightspace media session data is available, then use McLecture to select and download the recordings you need.

> [!CAUTION]
> McLecture is an independent student project. It is not affiliated with, sponsored by, or endorsed by McGill University.

## Features

- Course-aware recording discovery from captured myCourses media session data.
- Multi-select download flow with per-recording quality choices.
- Queue view for running, pending, completed, failed, and canceled jobs.
- Local `.mp4` remuxing with bundled FFmpeg assets.
- Download markers so previously saved recordings are easier to identify.
- Guide and diagnostics view for troubleshooting captured auth/session state.
- Deterministic README screenshot automation with fake fixture data.

## Product Preview

<p align="center">
  <img src="https://raw.githubusercontent.com/EnYiHou/mclecture/main/screenshots/popup.png?v=2bc0430" width="49%" alt="McLecture course view for selecting lecture recordings">
  <img src="https://raw.githubusercontent.com/EnYiHou/mclecture/main/screenshots/downloading.png?v=2bc0430" width="49%" alt="McLecture queue view showing active and pending downloads">
</p>

## Built With

- TypeScript
- React
- Vite
- Chrome Extension Manifest V3
- Vitest
- ESLint and Prettier
- Playwright for screenshot automation

## Installation

### Chrome Web Store

Install McLecture from the [Chrome Web Store](https://chromewebstore.google.com/detail/mclecture/ipnhkfogmlokecmpgjhdkkibomgbjmlb).

### Local Development Build

```bash
npm install
npm run build
```

Then load the generated extension:

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the generated `dist/` folder.

## Usage

1. Open [myCourses](https://mycourses2.mcgill.ca) and sign in.
2. Play at least one lecture recording so the media session data is available.
3. Click the McLecture extension action to open the overlay.
4. Expand a course, select recordings, choose download formats, and add them to the queue.
5. Keep the tab open while downloads are running.

## Development

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm test
```

Build artifacts are written to `dist/`.

## Screenshots

Regenerate the README screenshots with:

```bash
npm run screenshots
```

The screenshot workflow builds the extension in Vite screenshot mode, opens deterministic fixture states with Playwright, and writes:

- `screenshots/popup.png`
- `screenshots/downloading.png`
- `screenshots/help.png`

The README displays the course and queue screenshots. The help screenshot is still generated for maintainers and release assets.

These screenshots use fake course names, fake recordings, fake queue state, and fake diagnostics. They do not use real myCourses sessions, cookies, recordings, tokens, or course data.

If GitHub appears to keep showing old images after regeneration, update the `?v=` cache-busting value on the screenshot URLs in this README.

## Privacy Notes

- McLecture stores required session and download state in local browser extension storage.
- It does not include remote analytics.
- It does not send your course data to a third-party service.
- Downloads are handled through the browser and local extension runtime.

## Troubleshooting

If no courses or recordings appear:

- Open myCourses and play a lecture first.
- Click the extension action again after the lecture page has loaded.
- Check the Guide tab for captured-session diagnostics.
- Rebuild and reload the unpacked extension after local code changes.

## License

Distributed under the ISC License. See [LICENSE](./LICENSE) for details.
