// Builds the web version into dist/: the server (dist/server.js) and the pages for the browser (dist/public/). The
// renderer, its assets and the main process come from app/ unchanged (app/esbuild.config.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIR, build, buildPdfWorker, common as appCommon, copyRendererAssets, writeComponents } from '../app/esbuild.config.mjs';

const WEB = path.dirname(fileURLToPath(import.meta.url));
const at = (...p) => path.join(WEB, ...p);
const pub = at('dist', 'public');
// Packages of app/ also for the code in web/ (yazl, the renderer's libraries): one installation for both
const common = { ...appCommon, nodePaths: [path.join(APP_DIR, 'node_modules')] };

// The browser of the user can be older than the Chromium of Electron: what the bundled libraries use and older browsers
// lack, added before them (pdf.js uses Map.prototype.getOrInsertComputed, Chromium 145 and later have it)
const polyfill = `(() => {
  for (const C of [Map, WeakMap]) {
    if (!C.prototype.getOrInsert) Object.defineProperty(C.prototype, 'getOrInsert', { configurable: true, writable: true,
      value(k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); } });
    if (!C.prototype.getOrInsertComputed) Object.defineProperty(C.prototype, 'getOrInsertComputed', { configurable: true, writable: true,
      value(k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); } });
  }
})();`;
const page = { banner: { js: polyfill } };

fs.rmSync(at('dist'), { recursive: true, force: true });
await Promise.all([
  // Server: node-pty and dugite stay outside as on the desktop (dugite finds its Git relative to its package), they are
  // app/'s packages (bin/soma-web.cjs). ws comes into the bundle, its optional native helpers not.
  build({ ...common, entryPoints: [at('server', 'main.ts')], outfile: at('dist', 'server.js'), platform: 'node', format: 'cjs',
          external: ['node-pty', 'dugite', 'bufferutil', 'utf-8-validate', 'sherpa-onnx-node'] }),
  // Speech recognition for voice input (voice.ts forks it next to server.js); sherpa-onnx is app/'s package
  build({ ...common, entryPoints: [path.resolve(at('..'), 'app', 'src', 'main', 'voiceworker.ts')], outfile: at('dist', 'voiceworker.js'),
          platform: 'node', format: 'cjs', external: ['sherpa-onnx-node'] }),
  // The page: window.soma on the WebSocket, then the renderer of the desktop app
  build({ ...common, ...page, entryPoints: [at('client', 'main.ts')], outfile: path.join(pub, 'main.js'), platform: 'browser', format: 'iife' }),
  // The render page (hidden frame for soma render): window.somaRender on the WebSocket, then the render code of app/
  build({ ...common, ...page, entryPoints: [at('client', 'render.ts')], outfile: path.join(pub, 'render.js'), platform: 'browser', format: 'iife' }),
  buildPdfWorker(pub, page),
]);
writeComponents(at('dist', 'components.json'));
copyRendererAssets(pub);
