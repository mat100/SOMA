import type { RenderApi } from '../../app/src/shared/types';
import { WsTransport } from './transport';

/*
 * The render page of the browser version (render.html in a hidden frame of the tab, see renderframe.ts): what the
 * invisible window of the desktop does for `soma render` and videos (E58). window.somaRender on its own WebSocket
 * instead of render-preload.ts, then the render code of the desktop app unchanged (src/renderer/render.ts).
 */

void (async () => {
  // The server knows this page by the name it gave the frame
  const name = new URLSearchParams(location.search).get('w') ?? '';
  const t = new WsTransport('render', { offline: () => {}, online: () => {}, stopped: () => {} }, name);
  await t.connect();
  const api: RenderApi = {
    onJob: (cb) => { t.on('render:job', (job) => cb(job as Parameters<typeof cb>[0])); },
    done: (id, out) => t.send('render:done', id, out),
    progress: (id, f) => t.send('render:progress', id, f),
    ready: () => t.send('render:ready'),
  };
  window.somaRender = api;
  await import('../../app/src/renderer/render');
})();
