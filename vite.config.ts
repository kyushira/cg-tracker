import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Emits dist/sw.js from sw-template.js with the list of every built file, so
// the service worker can precache the whole app on first visit (offline from
// then on). The cache version is a hash of that file list.
function serviceWorker(): Plugin {
  return {
    name: 'cg-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      // index.html and public/ files aren't in `bundle` yet at this point, so list them explicitly.
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map')).map((f) => `./${f}`);
      const files = [...new Set(['./', './index.html', './manifest.webmanifest', './icon.svg', ...built])];
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      const tpl = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: tpl.replace("'__VERSION__'", JSON.stringify(version)).replace('__FILES__;', `${JSON.stringify(files)};`),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  base: './',
  server: { host: true },
  preview: { allowedHosts: ['.trycloudflare.com'] },
});
