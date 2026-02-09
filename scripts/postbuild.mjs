import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

await cp('manifest.json', 'dist/manifest.json');
await cp('icons', 'dist/icons', { recursive: true });
await cp('lib', 'dist/lib', { recursive: true });
