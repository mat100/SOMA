import { app, BrowserWindow, clipboard, dialog, ipcMain, net, shell } from 'electron';
import path from 'node:path';
import type { RenderJob, RenderOutput } from '../shared/types';
import type { Platform, RenderWindow, RenderWindowEvents } from './platform';

/** The desktop host (platform.ts): Electron with one window. `getWin` is that window, null before it opens and after it closes. */
export function electronPlatform(getWin: () => BrowserWindow | null): Platform {
  const win = () => { const w = getWin(); return w && !w.isDestroyed() ? w : null; };
  return {
    userData: () => app.getPath('userData'),
    documents: () => app.getPath('documents'),
    appRoot: () => app.getAppPath(),
    packagedResources: () => (app.isPackaged ? process.resourcesPath : null),
    send: (channel, ...args) => { win()?.webContents.send(channel, ...args); },
    async showOpenDialog(o) {
      const w = win();
      const r = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o);
      return r.canceled ? [] : r.filePaths;
    },
    async showSaveDialog(o) {
      const w = win();
      const r = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    async showMessageBox(o) {
      const w = win();
      const opts = { ...o, buttons: o.buttons ?? [], noLink: true };
      return (w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)).response;
    },
    showItemInFolder: (abs) => shell.showItemInFolder(abs),
    openPath: (abs) => shell.openPath(abs),
    openExternal: (url) => shell.openExternal(url),
    trashItem: (abs) => shell.trashItem(abs),
    writeClipboard: async (text) => clipboard.writeText(text),
    // net.fetch instead of fetch: it uses the proxy of the system
    fetch: (url, init) => net.fetch(url, init),
    openRenderWindow: (events) => electronRenderWindow(events),
  };
}

/**
 * Invisible window for images and videos (E58), with its own preload and page and the same viewer as on the screen.
 * The window answers through IPC. Only messages from this window count.
 */
function electronRenderWindow(events: RenderWindowEvents): RenderWindow {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800, title: 'SOMA Render',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'render-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  const onDone = (e: Electron.IpcMainEvent, id: number, out: RenderOutput) => { if (e.sender === wc) events.done(id, out); };
  const onProgress = (e: Electron.IpcMainEvent, id: number, f: number) => { if (e.sender === wc) events.progress(id, f); };
  let resolveReady: () => void = () => {};
  let fail: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; fail = reject; });
  const onReady = (e: Electron.IpcMainEvent) => { if (e.sender === wc) { ipcMain.removeListener('render:ready', onReady); resolveReady(); } };
  ipcMain.on('render:done', onDone);
  ipcMain.on('render:progress', onProgress);
  ipcMain.on('render:ready', onReady);
  let closing = false;
  const unlisten = () => {
    ipcMain.removeListener('render:done', onDone);
    ipcMain.removeListener('render:progress', onProgress);
    ipcMain.removeListener('render:ready', onReady);
  };
  wc.on('console-message', (_e, level, message) => { if (level >= 2) console.error(`[render] ${message}`); });
  wc.on('render-process-gone', (_e, d) => events.gone(d.reason));
  wc.once('did-fail-load', (_e, code, desc) => fail(new Error(`Render window does not load: ${desc} (${code})`)));
  // Closed by someone else than close(): open jobs fail now instead of at their time limit
  win.once('closed', () => {
    unlisten();
    fail(new Error('The render window was closed.'));
    if (!closing) events.gone('closed');
  });
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'render.html'));
  return {
    ready,
    send: (job: RenderJob) => { if (!wc.isDestroyed()) wc.send('render:job', job); },
    close: () => {
      closing = true;
      unlisten();
      fail(new Error('The render window was closed.'));
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
