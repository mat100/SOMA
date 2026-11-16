import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Platform, RenderWindow } from '../../app/src/main/platform';
import type { Tabs } from './tabs';

export interface WebConfig {
  /** app/ of the repository: resources/ and node_modules/ are there, as in development of the desktop app. */
  appDir: string;
  userData: string;
}

/**
 * The web host (platform.ts in app/src/main). The window of the desktop is the browser tab with the session (tabs.ts).
 * What only a browser can do (open a link, copy to the clipboard) the tab is asked for (Tabs.request, channels `web:*`).
 */
export function webPlatform(cfg: WebConfig, tabs: Tabs): Platform {
  return {
    userData: () => cfg.userData,
    documents: () => os.homedir(),
    appRoot: () => cfg.appDir,
    packagedResources: () => null,
    send: (channel, ...args) => tabs.emit(channel, args),
    // File dialogs in the browser come with the next step of the web version; until then they count as canceled
    showOpenDialog: async () => [],
    showSaveDialog: async () => null,
    // Questions are asked in the page (dialogs.ts). Without a page nobody can answer: the safe way is canceling.
    showMessageBox: async (o) => o.cancelId ?? Math.max(0, (o.buttons?.length ?? 1) - 1),
    showItemInFolder: () => {},
    openPath: async () => 'Opening files with another program is not available in the browser.',
    openExternal: (url) => tabs.request('web:openUrl', [url]),
    trashItem: async (abs) => {
      // No recycle bin on a server: a folder of its own in the app data, as in the tests (dialogs.ts)
      const bin = path.join(cfg.userData, 'trash');
      fs.mkdirSync(bin, { recursive: true });
      const dest = path.join(bin, `${Date.now()}-${path.basename(abs)}`);
      try { fs.renameSync(abs, dest); } catch (e) {
        // Another file system (a folder of the user, E103): copy first, remove only after the copy is complete
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        fs.cpSync(abs, dest, { recursive: true });
        fs.rmSync(abs, { recursive: true, force: true });
      }
    },
    writeClipboard: (text) => tabs.request('web:clipboard', [text]),
    fetch: (url, init) => fetch(url, init),
    openRenderWindow: (): RenderWindow => {
      const ready = Promise.reject(new Error('Rendering images and videos is not available in the browser version yet.'));
      ready.catch(() => {});
      return { ready, send: () => {}, close: () => {} };
    },
  };
}
