import { cp, mkdir, rm } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

await cp('manifest.json', 'dist/manifest.json');
await cp('icons', 'dist/icons', { recursive: true });
await cp('lib', 'dist/lib', { recursive: true });
await cp('dist/src/ui/popup.html', 'dist/popup.html');
await rm('dist/src', { recursive: true, force: true });
