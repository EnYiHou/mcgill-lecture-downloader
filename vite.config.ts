import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/ui/popup.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background' || chunkInfo.name === 'content') {
            return 'js/[name].js';
          }
          return 'assets/[name].js';
        },
        chunkFileNames: 'assets/chunks/[name].js',
        assetFileNames: ({ name }) => {
          if (name?.endsWith('.css')) {
            return 'css/[name]';
          }
          return 'assets/[name]';
        }
      }
    }
  }
});
