import type { RenderJob, RenderOutput } from '../shared/types';

/**
 * What the main process needs from its host. On the desktop that is Electron (electron-platform.ts), in the web version the
 * server in web/ (one user per container, the browser tab takes the place of the window). Everything else in src/main is
 * plain Node and does not know which of the two it runs in. The host sets it once at startup, before anything else runs.
 */
export interface Platform {
  /** App data (workspaces, settings, logs). */
  userData(): string;
  /** Start folder of the file dialogs. */
  documents(): string;
  /** The app folder: resources/ and node_modules/ are below it. */
  appRoot(): string;
  /** Resources of the installation package (bundled Python), null in development and in the web version. */
  packagedResources(): string | null;
  /** Message to the user interface (the window or the connected browser tab). Lost when nobody is there. */
  send(channel: string, ...args: unknown[]): void;
  /** Files or a folder to open. Empty list: canceled. */
  showOpenDialog(o: OpenDialogOptions): Promise<string[]>;
  /** Where to save. null: canceled. */
  showSaveDialog(o: SaveDialogOptions): Promise<string | null>;
  /** Question or notice, the index of the button. Only a fallback, the app asks in its own window first (dialogs.ts). */
  showMessageBox(o: MessageBoxOptions): Promise<number>;
  showItemInFolder(abs: string): void;
  /** Opens a file or folder with the default app. Empty string: done, otherwise the error. */
  openPath(abs: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  trashItem(abs: string): Promise<void>;
  /** Resolves once the text is in the clipboard, rejects when it could not get there (the browser refused). */
  writeClipboard(text: string): Promise<void>;
  /** Requests to the internet (checking for updates), through the proxy of the system where the host knows it. */
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Invisible page with the viewer for images and videos (render.ts). */
  openRenderWindow(events: RenderWindowEvents): RenderWindow;
}

export interface FileFilter { name: string; extensions: string[] }
export interface OpenDialogOptions {
  title: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: FileFilter[];
  properties: ('openFile' | 'openDirectory' | 'multiSelections' | 'createDirectory')[];
  /** The folder receives exported files: the web version offers to download them instead. */
  forExport?: boolean;
}
export interface SaveDialogOptions { title: string; defaultPath?: string; filters?: FileFilter[] }
export interface MessageBoxOptions {
  type: 'question' | 'info';
  title: string;
  message: string;
  detail?: string;
  /** Without buttons a notice with OK. */
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
}

export interface RenderWindowEvents {
  done(id: number, out: RenderOutput): void;
  progress(id: number, f: number): void;
  /** The page is gone (crash, closed tab): open jobs fail. */
  gone(reason: string): void;
}
export interface RenderWindow {
  /** Fulfilled once the page reports ready, rejected when it does not load. */
  readonly ready: Promise<void>;
  send(job: RenderJob): void;
  close(): void;
}

let current: Platform | null = null;

export function setPlatform(p: Platform): void { current = p; }

export function platform(): Platform {
  if (!current) throw new Error('No platform set (setPlatform at startup).');
  return current;
}
