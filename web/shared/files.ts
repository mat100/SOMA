/** Messages of the file dialogs between the server (web/server/platform.ts) and the page (web/client/files.ts). */

/** A folder on the server, as the dialogs show it. `more`: there were more entries than shown. */
export interface DirListing { dir: string; parent: string | null; root: string; entries: { name: string; dir: boolean }[]; more: boolean }

/** Answer of the page to an open dialog. `download` only for a folder that receives exported files. */
export type OpenAnswer = { kind: 'upload' | 'server'; paths: string[] } | { kind: 'download' } | null;
/**
 * Answer of the page to a save dialog. `model`: the model saved in its folder of the synced folder under this name (only
 * where the server offers it, see web/server/main.ts).
 */
export type SaveAnswer = { kind: 'download'; name: string } | { kind: 'server'; path: string } | { kind: 'model'; name: string } | null;

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 1000 && v.every((x) => typeof x === 'string');

/** The page is not trusted: only answers of the expected form count, anything else is a cancel. */
export function checkOpenAnswer(a: unknown, mayDownload: boolean): OpenAnswer {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  if ((o.kind === 'upload' || o.kind === 'server') && strings(o.paths)) return { kind: o.kind, paths: o.paths };
  if (o.kind === 'download' && mayDownload) return { kind: 'download' };
  return null;
}

export function checkSaveAnswer(a: unknown, mayModel = false): SaveAnswer {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  if (o.kind === 'download' && typeof o.name === 'string') return { kind: 'download', name: o.name };
  if (o.kind === 'server' && typeof o.path === 'string') return { kind: 'server', path: o.path };
  if (o.kind === 'model' && mayModel && typeof o.name === 'string') return { kind: 'model', name: o.name };
  return null;
}
