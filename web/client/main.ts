import { createSomaApi } from '../../app/src/shared/api';
import { closeDialogs, fileRequests } from './files';
import { removeRenderFrames, renderFrames } from './renderframe';
import { WsTransport } from './transport';
import type { BuildInfo } from '../shared/protocol';
import { showOffline, showStopped, webRequests } from './webui';

/*
 * SOMA in the browser: window.soma on the WebSocket instead of Electron's preload, then the renderer of the desktop app
 * unchanged (src/renderer/main.ts). This bundle is main.js next to index.html.
 */

/**
 * Which code the server runs, next to the version on the start page and in the title of the home button: the commit of
 * a deployment tells whether a change is in it.
 */
function showBuild(b: BuildInfo | undefined): void {
  if (!b?.commit) return;
  const label = `${b.branch ? `${b.branch} ` : ''}${b.commit.slice(0, 7)}${b.dirty ? '+' : ''}`;
  const version = document.getElementById('start-version');
  if (version) {
    version.textContent = `${version.textContent} · ${label}`;
    version.title = `Server: ${b.branch ?? 'commit'} ${b.commit}${b.dirty ? ' with uncommitted changes' : ''}${b.built ? `, built ${b.built}` : ''}`;
  }
  const home = document.getElementById('btn-home');
  if (home) home.title = `${home.title} · ${label}`;
}

void (async () => {
  // Relative addresses (styles, fonts, WebSocket) need the page as a folder, also below the prefix of a proxy
  if (!location.pathname.endsWith('/') && !location.pathname.endsWith('.html')) {
    location.replace(`${location.pathname}/${location.search}${location.hash}`);
    return;
  }
  const t = new WsTransport('main', {
    offline: () => { closeDialogs(); showOffline(true); },
    online: () => showOffline(false),
    stopped: (reason, message) => { closeDialogs(); removeRenderFrames(); showStopped(reason, message); },
  });
  const env = await t.connect();
  window.soma = createSomaApi(t, { ...env, platform: 'web' });
  webRequests(t);
  fileRequests(t);
  renderFrames(t);
  // Only now: the renderer reads window.soma when it loads
  await import('../../app/src/renderer/main');
  showBuild(env.build);
})();
