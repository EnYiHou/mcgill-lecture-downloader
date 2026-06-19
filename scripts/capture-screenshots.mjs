import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const extensionPath = join(repoRoot, 'dist');
const screenshotDir = join(repoRoot, 'screenshots');

const scenarios = [
  ['popup', 'popup.png'],
  ['downloading', 'downloading.png'],
  ['help', 'help.png']
];

async function getExtensionId(context) {
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  }

  const [, , extensionId] = serviceWorker.url().split('/');
  if (!extensionId) {
    throw new Error(`Unable to resolve extension id from service worker URL: ${serviceWorker.url()}`);
  }

  return extensionId;
}

async function captureScenario(context, extensionId, scenario, filename) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1206, height: 1206 });
  await page.goto(`chrome-extension://${extensionId}/popup.html?screenshot=${scenario}`);
  await page.waitForSelector('[data-screenshot-ready="true"]', { timeout: 15_000 });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(screenshotDir, filename),
    fullPage: false,
    animations: 'disabled'
  });
  await page.close();
}

const userDataDir = await mkdtemp(join(tmpdir(), 'mclecture-screenshots-'));

try {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1206, height: 1206 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=1206,1206'
    ]
  });

  try {
    const extensionId = await getExtensionId(context);
    for (const [scenario, filename] of scenarios) {
      await captureScenario(context, extensionId, scenario, filename);
      console.log(`Captured screenshots/${filename}`);
    }
  } finally {
    await context.close();
  }
} finally {
  await rm(userDataDir, { recursive: true, force: true });
}
