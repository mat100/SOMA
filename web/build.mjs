// Builds the web version into dist/: the server (dist/server.js) and the pages for the browser (dist/public/). The
// renderer, its assets and the main process come from app/ unchanged (app/esbuild.config.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, buildPdfWorker, common, copyRendererAssets, writeComponents } from '../app/esbuild.config.mjs';

const WEB = path.dirname(fileURLToPath(import.meta.url));
const at = (...p) => path.join(WEB, ...p);
const pub = at('dist', 'public');

fs.rmSync(at('dist'), { recursive: true, force: true });
await Promise.all([
  // Server: node-pty and dugite stay outside as on the desktop (dugite finds its Git relative to its package), they are
  // app/'s packages (bin/soma-web.cjs). ws comes into the bundle, its optional native helpers not.
  build({ ...common, entryPoints: [at('server', 'main.ts')], outfile: at('dist', 'server.js'), platform: 'node', format: 'cjs',
          external: ['node-pty', 'dugite', 'bufferutil', 'utf-8-validate'] }),
  // The page: window.soma on the WebSocket, then the renderer of the desktop app
  build({ ...common, entryPoints: [at('client', 'main.ts')], outfile: path.join(pub, 'main.js'), platform: 'browser', format: 'iife' }),
  build({ ...common, entryPoints: ['src/renderer/render.ts'], outfile: path.join(pub, 'render.js'), platform: 'browser', format: 'iife' }),
  buildPdfWorker(pub),
]);
writeComponents(at('dist', 'components.json'));
copyRendererAssets(pub);
