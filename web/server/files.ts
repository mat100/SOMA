import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import type { DirListing } from '../shared/files';

/*
 * Files between the browser and the server. The models live on the server (one user per container); the browser brings
 * files in by uploading them and takes files out by downloading them:
 * - Uploads: dropped or chosen files go to `<app data>/uploads/<batch>/` first, the main process then takes them from
 *   there as from any path on the desktop (importing, opening a .soma).
 * - Downloads: a save dialog answered with "Download" gives the main process a path below `<app data>/downloads/`.
 *   Whatever lands there (written by an export, saving a model) the browser downloads, again after every change (saving
 *   the same model again). A folder (all parts as single files) comes as a ZIP. The download itself is a copy made at
 *   that moment (`<app data>/download-links/`), so a later save cannot change a file that is being fetched.
 */

/** Uploads are copies the main process took over: removed after a day. */
const KEEP_UPLOADS_MS = 24 * 60 * 60 * 1000;
/** Download places unchanged for this long are removed (a model saved there again stays). */
const KEEP_DOWNLOADS_MS = 7 * 24 * 60 * 60 * 1000;
/** A download link lives this long. */
const LINK_MS = 10 * 60_000;
/** Largest file the browser can upload. */
const MAX_UPLOAD = 4 * 1024 ** 3;
/** Entries shown per folder in the dialogs. */
const MAX_ENTRIES = 2000;

const nameOk = (n: string) => n.length > 0 && n.length <= 255 && n !== '.' && n !== '..' && !/[\\/\0]/.test(n);
/** A file name from the browser as a name for the disk: no folders, nothing the system does not allow. */
export const safeName = (n: string) => {
  const s = path.basename(n.replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
  return nameOk(s) ? s : 'file';
};

/**
 * Is `abs` below `root`, also after following links? For paths the page names (saving or opening on the server): a link
 * inside the root that points elsewhere must not lead out. A path that does not exist yet counts by its folder.
 */
export function insideRoot(root: string, abs: string): boolean {
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return false; }
  let p = path.resolve(abs);
  const rest: string[] = [];
  for (;;) {
    try { p = path.join(fs.realpathSync(p), ...rest); break; } catch {
      const up = path.dirname(p);
      if (up === p) return false;
      rest.unshift(path.basename(p));
      p = up;
    }
  }
  return p === realRoot || p.startsWith(realRoot + path.sep);
}

export class Files {
  readonly uploads: string;
  readonly downloads: string;
  private readonly links: string;
  /** What was handed to the browser per staged path: its state when it was delivered, to deliver again only when changed. */
  private delivered = new Map<string, string>();
  /** Tokens of /download/<token> → the copy to send. */
  private tokens = new Map<string, { file: string; name: string }>();

  constructor(userData: string, private readonly send: (url: string, name: string) => Promise<unknown>) {
    this.uploads = path.join(userData, 'uploads');
    this.downloads = path.join(userData, 'downloads');
    this.links = path.join(userData, 'download-links');
    for (const dir of [this.uploads, this.downloads]) fs.mkdirSync(dir, { recursive: true });
    // Links do not survive a restart
    fs.rmSync(this.links, { recursive: true, force: true });
    this.sweep();
    setInterval(() => this.sweep(), 60 * 60_000).unref();
  }

  /** Removes old uploads and download places nobody wrote to for a long time. */
  private sweep(): void {
    const old = (dir: string, ms: number) => {
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const d of names) {
        const abs = path.join(dir, d);
        try { if (Date.now() - newest(abs) > ms) fs.rmSync(abs, { recursive: true, force: true }); } catch { /* next time */ }
      }
    };
    old(this.uploads, KEEP_UPLOADS_MS);
    old(this.downloads, KEEP_DOWNLOADS_MS);
  }

  /**
   * For the page: a path in the download area is a place on the server the user never sees, the file went to their
   * computer. Messages name the file instead ("Saved: Box.soma" rather than a folder of the server).
   */
  forPage<T>(value: T): T {
    const root = this.downloads + path.sep;
    const map = (v: unknown): unknown => {
      if (typeof v === 'string') return v.startsWith(root) ? v.slice(root.length).split(path.sep).slice(1).join('/') || v : v;
      if (Array.isArray(v)) return v.map(map);
      if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)]));
      }
      return v;
    };
    return map(value) as T;
  }

  /** A place for something the browser will download: `name` in a folder of its own. */
  stage(name: string): string {
    const dir = path.join(this.downloads, randomBytes(8).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, safeName(name));
  }

  /**
   * Moves an uploaded file into the download area, as already delivered: the main process keeps it as the model's file
   * (saving writes to it again), and each later save goes to the browser as a download.
   */
  adopt(uploaded: string): string {
    const staged = this.stage(path.basename(uploaded));
    fs.renameSync(uploaded, staged);
    const sig = signature(staged);
    if (sig) this.delivered.set(staged, sig);
    return staged;
  }

  /**
   * Hands staged files that are new or changed to the browser. The caller makes sure no request is running: an export
   * still writing its files must not go out half done.
   */
  async deliverChanged(): Promise<void> {
    let dirs: string[];
    try { dirs = fs.readdirSync(this.downloads); } catch { return; }
    for (const d of dirs) {
      let entries: string[];
      try { entries = fs.readdirSync(path.join(this.downloads, d)); } catch { continue; }
      for (const e of entries) {
        const abs = path.join(this.downloads, d, e);
        // Written through a temporary file (.part, see render.ts and zip.ts): only finished files count
        if (/\.(part|tmp)$/i.test(e)) continue;
        const sig = signature(abs);
        if (!sig || this.delivered.get(abs) === sig) continue;
        // Counted as delivered only when the browser took it: otherwise the next request offers it again
        try { await this.deliver(abs); this.delivered.set(abs, sig); } catch (err) { console.warn('[web] download:', err); }
      }
    }
  }

  /** Lets the browser download a copy of a file as it is now, a folder as a ZIP. */
  async deliver(abs: string): Promise<unknown> {
    const token = randomBytes(16).toString('base64url');
    const isDir = fs.statSync(abs).isDirectory();
    const name = path.basename(abs) + (isDir ? '.zip' : '');
    const dir = path.join(this.links, token);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'file');
    if (isDir) {
      const zip = new yazl.ZipFile();
      for (const rel of listFiles(abs)) zip.addFile(path.join(abs, rel), rel.split(path.sep).join('/'));
      zip.end();
      await pipeline(zip.outputStream, fs.createWriteStream(file));
    } else {
      await fs.promises.copyFile(abs, file);
    }
    this.tokens.set(token, { file, name });
    // A download link is good for a while, then it is gone (a page that never fetched it)
    setTimeout(() => { this.tokens.delete(token); fs.rmSync(dir, { recursive: true, force: true }); }, LINK_MS).unref();
    return this.send(`download/${token}`, name);
  }

  /** GET download/<token>. */
  async serveDownload(res: ServerResponse, token: string): Promise<void> {
    const t = this.tokens.get(token);
    if (!t) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('This download is no longer available.'); return; }
    let st: fs.Stats;
    try { st = fs.statSync(t.file); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': t.name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${t.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(t.name)}`,
      'Cache-Control': 'no-store',
    });
    await pipeline(fs.createReadStream(t.file), res).catch(() => {});
  }

  /** POST upload?batch=…&name=…: the body is the file. Answers with its path on the server. */
  async receiveUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const batch = url.searchParams.get('batch') ?? '';
    const name = url.searchParams.get('name') ?? '';
    if (!/^[a-f0-9]{16,64}$/.test(batch) || !name) { res.writeHead(400).end(); return; }
    const size = Number(req.headers['content-length']);
    if (!Number.isFinite(size) || size > MAX_UPLOAD) { res.writeHead(413, { 'Content-Type': 'text/plain' }).end('The file is too large.'); return; }
    const dir = path.join(this.uploads, batch);
    fs.mkdirSync(dir, { recursive: true });
    // Two files of the same name in one batch (from different folders): the second gets a number. Created exclusively,
    // so two uploads at the same time never share a file
    const p = path.parse(safeName(name));
    let file = '';
    let fd: fs.promises.FileHandle | null = null;
    for (let i = 1; !fd && i < 1000; i++) {
      file = path.join(dir, i === 1 ? `${p.name}${p.ext}` : `${p.name} (${i})${p.ext}`);
      try { fd = await fs.promises.open(file, 'wx'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    if (!fd) { res.writeHead(409).end(); return; }
    try {
      await pipeline(req, fd.createWriteStream());
    } catch (e) {
      // Only the file this upload created
      fs.rmSync(file, { force: true });
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Upload failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: file }));
  }
}

/** When something below `abs` was last written. */
function newest(abs: string): number {
  const st = fs.statSync(abs);
  if (!st.isDirectory()) return st.mtimeMs;
  return Math.max(st.mtimeMs, ...fs.readdirSync(abs).map((e) => newest(path.join(abs, e))));
}

function signature(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return `${st.size}:${st.mtimeMs}`;
    const files = listFiles(abs);
    if (!files.length) return null;
    return files.map((f) => { const s = fs.statSync(path.join(abs, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|');
  } catch { return null; }
}

function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile() && !/\.(part|tmp)$/i.test(e.name)) out.push(r);
  }
  return out;
}

/** A folder on the server for the dialogs, only below `root` (the user's home). Outside: the root itself. */
export function listDir(root: string, dir: unknown): DirListing {
  const want = typeof dir === 'string' && dir ? path.resolve(dir) : root;
  const abs = insideRoot(root, want) && fs.existsSync(want) ? want : root;
  const all = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isFile()));
  const entries = all.slice(0, MAX_ENTRIES)
    .map((e) => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { dir: abs, parent: abs === root ? null : path.dirname(abs), root, entries, more: all.length > MAX_ENTRIES };
}
