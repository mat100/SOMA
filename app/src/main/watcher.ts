import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { affectsAnimation, affectsBuild } from '../shared/editable';

/** Ordner, die nie einen Build oder eine Neuanzeige der Dateiliste ausloesen (Ausgaben wuerden sich sonst selbst anstossen). */
export const IGNORED_TOP = new Set(['.git', '.soma', 'output', 'exports', '__pycache__', 'node_modules', '.venv', 'venv', 'env']);

const topSegment = (rel: string) => rel.split(/[\\/]/)[0] ?? '';
/** Markierungen (E16) und Kopien der Skills stehen im Dateibaum: Änderungen dort frischen die Liste auf, bauen aber nie. */
const isShown = (rel: string) => /^\.soma[\\/](feedback|skills)([\\/]|$)/i.test(rel);
const isIgnored = (rel: string) => IGNORED_TOP.has(topSegment(rel)) || rel.split(/[\\/]/).includes('__pycache__');
/** `soma build` schreibt build.json als Letztes, auch wenn der Agent im Terminal baut statt die App. */
const isBuildResult = (rel: string) => /^\.soma[\\/]build\.json$/i.test(rel);
/** Zeichnungen (E76): neuer Index von `soma drawing build` (auch aus dem Terminal) oder eine geänderte Zeichnungsdatei. */
const isDrawing = (rel: string) => /^\.soma[\\/]drawings[\\/]index\.json$/i.test(rel) || /^drawings[\\/][^\\/]+\.py$/i.test(rel);
/** Quelltext-Aenderung: dieselbe Regel wie beim Speichern im Editor (src/shared/editable.ts). */
const isSource = affectsBuild;

/**
 * Beobachtet den Projektordner. `onSource` bei relevanten Aenderungen (fuer Auto-Build), `onFiles` fuer die Dateiliste,
 * `onAnim` bei Aenderungen an animations/*.py (E58), `onBuilt` bei einem neuen Build-Ergebnis, `onDrawings` bei neuen
 * Zeichnungen (entprellt). Gibt eine Funktion zum Beenden zurueck. Fehler des Watchers werden verschluckt: ohne Watcher bleibt der Knopf.
 */
export function watchProject(dir: string, onSource: (rel: string | null) => void, onFiles: () => void, onAnim: (rel: string) => void = () => {},
  onBuilt: () => void = () => {}, onDrawings: () => void = () => {}): () => void {
  let filesTimer: NodeJS.Timeout | null = null;
  let drawTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = watchTree(dir, (_evt, filename) => {
      const rel = filename ? String(filename) : '';
      if (rel && isBuildResult(rel)) { onBuilt(); return; }
      if (rel && isDrawing(rel)) {
        if (drawTimer) clearTimeout(drawTimer);
        drawTimer = setTimeout(onDrawings, 300);
      }
      if (rel && isIgnored(rel) && !isShown(rel)) return;
      if (rel && affectsAnimation(rel)) onAnim(rel.replace(/\\/g, '/'));
      else if (!rel || (isSource(rel) && !isShown(rel))) onSource(rel || null);
      if (filesTimer) clearTimeout(filesTimer);
      filesTimer = setTimeout(onFiles, 250);
    });
    watcher.on('error', () => { /* Projektordner weg oder gesperrt: nichts zu tun */ });
  } catch { /* Watcher nicht verfuegbar */ }
  return () => { if (filesTimer) clearTimeout(filesTimer); if (drawTimer) clearTimeout(drawTimer); watcher?.close(); };
}

/** Folders not worth watching on Linux (many files, never shown or built): Git, packages, the project environment (E67). */
const UNWATCHED = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);
const unwatched = (rel: string) => UNWATCHED.has(path.basename(rel)) || /^(env|\.soma[\\/]env)$/.test(rel);

/**
 * fs.watch for a whole folder. Windows and macOS watch recursively by themselves. Node does it on Linux file by file,
 * and a file replaced by renaming (the editor saves that way, files.ts) is not watched any more: a later change by the
 * agent went unnoticed (no build, editor not updated). On Linux therefore one watcher per folder, which sees every
 * file in it, also new and replaced ones; new folders get their own.
 */
function watchTree(root: string, cb: (evt: string, rel: string) => void): fs.FSWatcher {
  if (process.platform !== 'linux') return fs.watch(root, { recursive: true }, (evt, f) => cb(evt, f ? String(f) : ''));
  const watchers = new Map<string, fs.FSWatcher>();
  const add = (rel: string, announce: boolean) => {
    if (watchers.has(rel) || (rel && unwatched(rel))) return;
    const abs = path.join(root, rel);
    let w: fs.FSWatcher;
    try {
      w = fs.watch(abs, (evt, name) => {
        const r = name ? (rel ? path.join(rel, String(name)) : String(name)) : rel;
        cb(evt, r);
        if (evt !== 'rename' || !name) return;
        // A new folder: watch it too. A folder gone: its watchers end
        let isDir = false;
        try { isDir = fs.statSync(path.join(root, r)).isDirectory(); } catch { /* gone */ }
        if (isDir) add(r, true);
        else for (const [k, x] of watchers) if (k === r || k.startsWith(r + path.sep)) { x.close(); watchers.delete(k); }
      });
    } catch { return; }
    w.on('error', () => { w.close(); watchers.delete(rel); });
    watchers.set(rel, w);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { /* gone again */ }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name;
      // Written into a new folder before its watcher stood: report it, so nothing in it is missed
      if (announce) cb('rename', r);
      if (e.isDirectory()) add(r, announce);
    }
  };
  add('', false);
  // What watchProject needs of an FSWatcher: close() and on('error')
  return Object.assign(new EventEmitter(), { close: () => { for (const w of watchers.values()) w.close(); watchers.clear(); } }) as unknown as fs.FSWatcher;
}
