import fs from 'node:fs';
import path from 'node:path';
import type { OpenDialogOptions, Platform, SaveDialogOptions } from '../../app/src/main/platform';
import { checkOpenAnswer, checkSaveAnswer } from '../shared/files';
import { insideRoot, type Files } from './files';
import type { RenderFrames } from './render';
import type { Tabs } from './tabs';

export interface WebConfig {
  /** app/ of the repository: resources/ and node_modules/ are there, as in development of the desktop app. */
  appDir: string;
  userData: string;
  /** Folder on the server the dialogs may show (the user's home). */
  filesRoot: string;
}

/**
 * The web host (platform.ts in app/src/main). The window of the desktop is the browser tab with the session (tabs.ts).
 * What only a browser can do (open a link, copy to the clipboard, choose files) the tab is asked for (Tabs.request,
 * channels `web:*`). Files come in as uploads and go out as downloads (files.ts).
 */
export function webPlatform(cfg: WebConfig, tabs: Tabs, files: Files, renders: RenderFrames): Platform {
  const root = cfg.filesRoot;
  return {
    userData: () => cfg.userData,
    documents: () => root,
    appRoot: () => cfg.appDir,
    packagedResources: () => null,
    send: (channel, ...args) => tabs.emit(channel, args),
    async showOpenDialog(o: OpenDialogOptions) {
      const a = checkOpenAnswer(await tabs.request('web:openDialog', [{ ...o, defaultPath: dialogDir(root, o.defaultPath), root }], true),
        !!o.forExport && o.properties.includes('openDirectory'));
      if (!a) return [];
      if (a.kind === 'download') {
        // A folder for exported files, downloaded as a ZIP once they are written. Not named after the suggested folder:
        // that is a place on the server (the home folder at first), no name for the download
        const dir = files.stage('export');
        fs.mkdirSync(dir, { recursive: true });
        return [dir];
      }
      // Only what this server handed out: uploads, or places below the folder the dialogs show
      const paths = a.paths.filter((p) => (a.kind === 'upload' ? insideRoot(files.uploads, p) : insideRoot(root, p)));
      // An uploaded model (.soma, .zip) stays the file the model saves to, as on the desktop: saving downloads it again
      const model = o.filters?.some((f) => f.extensions.includes('soma'));
      return a.kind === 'upload' && model ? paths.map((p) => files.adopt(p)) : paths;
    },
    async showSaveDialog(o: SaveDialogOptions) {
      const name = path.basename(o.defaultPath ?? '') || 'file';
      const dir = dialogDir(root, o.defaultPath ? path.dirname(o.defaultPath) : undefined);
      const a = checkSaveAnswer(await tabs.request('web:saveDialog', [{ ...o, name, defaultPath: dir, root }], true));
      if (!a) return null;
      if (a.kind === 'download') return files.stage(a.name || name);
      return insideRoot(root, a.path) ? path.resolve(a.path) : null;
    },
    // Questions are asked in the page (dialogs.ts). Without a page nobody can answer: the safe way is canceling.
    showMessageBox: async (o) => o.cancelId ?? Math.max(0, (o.buttons?.length ?? 1) - 1),
    // No file manager of the server to show: the browser downloads the file (a folder as a ZIP)
    showItemInFolder: (abs) => { void files.deliver(abs).catch((e: unknown) => console.warn('[web] download:', e)); },
    openPath: async (abs) => {
      try { await files.deliver(abs); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
    },
    openExternal: async (url) => { await tabs.request('web:openUrl', [url]); },
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
    writeClipboard: async (text) => { await tabs.request('web:clipboard', [text]); },
    fetch: (url, init) => fetch(url, init),
    // In the user's tab, with the GPU of their computer (render.ts)
    openRenderWindow: (events) => renders.open(events),
  };
}

/** Where a dialog starts: the suggested folder when it is below the root, otherwise the root. */
function dialogDir(root: string, dir: string | undefined): string {
  if (!dir) return root;
  let d = path.resolve(dir);
  // A suggested file (open dialog with a path): its folder
  try { if (!fs.statSync(d).isDirectory()) d = path.dirname(d); } catch { d = path.dirname(d); }
  return insideRoot(root, d) && fs.existsSync(d) ? d : root;
}
