import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/*
 * The synced folder (SOMA_MIRROR_DIR): the results of the open model as plain files in a folder of the server, one folder
 * per model, so a sync tool (Coder Desktop's file sync in a Coder workspace) brings them to the user's computer. The
 * folder is a copy, written in one direction only: the model never reads from it.
 *
 *   <root>/<model name>/model.step, drawings.pdf, drawings/…   from output/ of the model, after each change
 *   <root>/<model name>/renders/…                              from renders/
 *   <root>/<model name>/<model name>.soma                      the model file, after each save
 *   <root>/<model name>/versions/<date> <message>/…            the results as they are at each save (SOMA_MIRROR_VERSIONS)
 *   <root>/<model name>/.soma-mirror.json                      which model this is and what SOMA wrote
 *
 * The user may change or delete files there (on their computer, the sync brings it back). So nothing is overwritten that
 * SOMA did not write itself: a file changed by the user stays, the new one goes next to it as "<name> (from SOMA).<ext>",
 * and the page says so. A file the user deleted comes back only when the model has a new one. Nothing is ever deleted.
 * Links are never followed, neither in the model (an agent may put one there) nor in the folder (the sync may bring one).
 *
 * When the folder is also where the dialogs of the page are (SOMA_WEB_FILES), it is the home of the model (main.ts): the
 * model file is saved right there, <model name>.soma, and is then only noted here, not copied onto itself. A renamed model
 * takes its folder along when everything in it is SOMA's (claim).
 */

/** The model the folder is for. `file`: its model file, a folder of the user holding it may become the model's folder. */
export interface MirrorModel { id: string; name: string; dir: string; file?: string | null }
/** The model file after a save (save:state): the commit of the save and where the file is. */
export interface MirrorSave { head: string | null; zipPath: string | null }

/** A file of the folder the user changed. `copy`: where the new one from SOMA is; `updated` false when that one was changed too. */
export interface MirrorKept { file: string; copy: string; updated: boolean }
export interface MirrorStatus {
  /** Folder of the model, null when there is none (yet). */
  folder: string | null;
  state: 'ok' | 'error';
  /** Error, or what was left out (a run may copy most files and still report one). */
  error?: string;
  kept: MirrorKept[];
  syncedAt?: number;
  /** Something to tell the user once (the folder of a renamed model could not move along). */
  notice?: string;
}

interface FileRecord {
  /** The source when it was copied: unchanged source, nothing to do. */
  srcSize: number;
  srcMtime: number;
  /** What SOMA wrote: is the file in the folder still that one? */
  hash: string;
}
interface Manifest {
  id: string;
  files: Record<string, FileRecord>;
  /** Files the user changed, with the place of the new one (until the user's file is gone). */
  kept?: Record<string, MirrorKept>;
  /** Commit of the last save seen (a version folder for each new one). */
  savedHead?: string | null;
  /** The model name and the folder name SOMA gave it: a renamed model takes the folder along only while it is still that. */
  name?: string;
  folder?: string;
}

export interface MirrorOptions {
  /** A folder versions/<date> <message>/ for each save. */
  versions: boolean;
  /**
   * The folders are the models' home (web/server/main.ts): second folders of a name are "<name> (2)", … rather than
   * "<name> (<start of the ID>)", a renamed model takes its folder along, and a model file elsewhere in the folder is not
   * copied into the model's folder.
   */
  home?: boolean;
  onStatus?: (s: MirrorStatus) => void;
}

const MANIFEST = '.soma-mirror.json';
const TMP_PREFIX = '.soma-mirror-tmp-';
/** Folders of the model whose files are results. output/ goes to the top of the folder, renders/ stays renders/. */
const SOURCES: { from: string; to: string }[] = [{ from: 'output', to: '' }, { from: 'renders', to: 'renders' }];
/** Names at the top of the folder that belong to the mirror itself: a file of output/ with such a name is left out. */
const RESERVED = new Set(['renders', 'versions', MANIFEST]);
/** Files per folder of the model at most (an agent writing thousands of renders must not fill the disk unnoticed). */
const MAX_FILES = 2000;

const nameOk = (n: string) => n.length > 0 && n !== '.' && n !== '..' && !/[\\/\0]/.test(n);
/** A name for a folder or file on any system the sync may bring it to (Windows the strictest). */
export function folderName(name: string, fallback = 'model'): string {
  const s = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 80);
  return nameOk(s) && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s) ? s : fallback;
}

/** "<name> (from SOMA).<ext>" next to a file the user changed. */
export function copyName(rel: string): string {
  const ext = path.posix.extname(rel);
  return `${rel.slice(0, rel.length - ext.length)} (from SOMA)${ext}`;
}

const lstat = (p: string): fs.Stats | null => { try { return fs.lstatSync(p); } catch { return null; } };
/** Is `abs` below `root` (paths only, as the server names them)? */
const below = (root: string, abs: string) => { const r = path.relative(root, abs); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
/** Folder names a model of this name may have: the name, a number added, or the start of the ID (folders of older versions). */
const isNameOf = (folder: string, name: string) => folder === name || (folder.startsWith(`${name} (`) && /^ \((\d+|[0-9a-f]{8})\)$/.test(folder.slice(name.length)));
const isEmpty = (dir: string) => { try { return fs.readdirSync(dir).length === 0; } catch { return false; } };
const tmpName = () => `${TMP_PREFIX}${randomBytes(6).toString('hex')}`;

/** A JSON file, not through a link. */
function readManifest(file: string): Manifest | null {
  if (!lstat(file)?.isFile()) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    return typeof m?.id === 'string' && m.files && typeof m.files === 'object' ? m : null;
  } catch { return null; }
}

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Files below `dir` (relative, with `/`): only plain files and folders, no links, nothing hidden. */
function listFiles(dir: string, what: string): { files: string[]; problem?: string } {
  const files: string[] = [];
  const st = lstat(dir);
  if (!st) return { files };
  if (!st.isDirectory()) return { files, problem: `${what} is not a folder (a link?), left out.` };
  let problem: string | undefined;
  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch (e) {
      problem = `${what}/${rel} could not be read: ${(e as Error).message}`;
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (files.length >= MAX_FILES) { problem = `More than ${MAX_FILES} files in ${what}/: only the first ${MAX_FILES} are copied.`; return; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) files.push(r);
    }
  };
  walk('');
  return { files, problem };
}

/**
 * The folders on the way to `rel` below `base`, made where missing. Refuses a link or a file on the way: the sync may
 * bring links from the user's computer, and writing through one would leave the folder.
 */
function prepareDir(base: string, rel: string): string {
  let dir = base;
  for (const part of rel.split('/').slice(0, -1)) {
    dir = path.join(dir, part);
    const st = lstat(dir);
    if (!st) fs.mkdirSync(dir);
    else if (!st.isDirectory()) throw new Error(`${dir} is not a folder (a link?): nothing written through it.`);
  }
  return path.join(base, ...rel.split('/'));
}

/** Copy through a temporary file and rename: the sync never sees half a file. Returns the hash of what was written. */
async function copyAtomic(src: string, dest: string): Promise<string> {
  const tmp = path.join(path.dirname(dest), tmpName());
  try {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
    const hash = await hashFile(tmp);
    fs.renameSync(tmp, dest);
    return hash;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left */ }
    throw e;
  }
}

/** Is the file in the folder the one SOMA wrote (`rec`)? 'missing' when there is none, 'other' when it is not ours. */
async function owner(file: string, rec: FileRecord | undefined): Promise<'ours' | 'missing' | 'other'> {
  const st = lstat(file);
  if (!st) return 'missing';
  if (!rec || !st.isFile()) return 'other';
  return (await hashFile(file)) === rec.hash ? 'ours' : 'other';
}

/** The subject of a commit, for the name of a version folder. Empty when git cannot tell. */
function commitSubject(dir: string, head: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'log', '-1', '--format=%s', head], { timeout: 10_000 }, (err, out) => resolve(err ? '' : out.trim()));
  });
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;

export class Mirror {
  readonly root: string;
  private readonly opts: MirrorOptions;
  /** Waiting requests per model, one run at a time. A save waiting stays when a later request has none. */
  private readonly queue = new Map<string, { model: MirrorModel; save?: MirrorSave }>();
  private running: Promise<void> | null = null;
  /** Runs and claims one after another: a folder must not move while files are written into it. */
  private lock: Promise<unknown> = Promise.resolve();
  /**
   * The name a model was claimed under, until release: the model takes it only a moment later (projects.ts renames it
   * after the save dialog), and a sync in between must not move the folder back under the old name.
   */
  private readonly claimed = new Map<string, string>();
  /** Folder per model as found last, so a sync does not look through all folders each time. */
  private readonly known = new Map<string, string>();
  private last: MirrorStatus | null = null;

  constructor(root: string, opts: MirrorOptions) {
    this.root = root;
    this.opts = opts;
  }

  status(): MirrorStatus | null { return this.last; }

  /** Brings the folder of the model up to date. Resolves once it is; errors end up in the status, never thrown. */
  sync(model: MirrorModel, save?: MirrorSave): Promise<void> {
    const waiting = this.queue.get(model.id);
    this.queue.set(model.id, { model, save: save ?? waiting?.save });
    this.running ??= (async () => {
      try {
        for (let next = this.take(); next; next = this.take()) {
          const n = next;
          await this.exclusive(() => this.run(n.model, n.save));
        }
      } finally { this.running = null; }
    })();
    return this.running;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.lock.then(fn);
    this.lock = r.catch(() => {});
    return r;
  }

  /**
   * The folder of the model now, made (or moved along, see folderFor) where needed, for saving the model file into it.
   * `moveFile`: a renamed model's file goes along with its folder as <new name>.soma (saving under the new name next).
   * Throws when there is no folder for it.
   */
  claim(model: MirrorModel, opts: { moveFile?: boolean } = {}): Promise<string> {
    this.claimed.set(model.id, model.name);
    return this.exclusive(async () => {
      const { dir, notice } = await this.folderFor(model, opts);
      const known = readManifest(path.join(dir, MANIFEST));
      const m: Manifest = known?.id === model.id ? known : { id: model.id, files: {}, kept: {} };
      this.writeManifest(dir, { ...m, name: model.name, folder: path.basename(dir) });
      if (notice) this.report({ ...(this.last ?? { state: 'ok', kept: [] }), folder: dir, notice });
      return dir;
    });
  }

  /** The model has the name it was claimed under now (or keeps its old one, the save was canceled). */
  release(id: string): void { this.claimed.delete(id); }

  /**
   * A name for a new model (or the open one under a new name, `id`): the name as a folder name, and the first one of
   * "<name>", "<name> (2)", … that has no folder of something else yet.
   */
  suggestName(name: string, id?: string): { name: string; free: string } {
    const n = folderName(name.trim(), '');
    if (!n) return { name: '', free: '' };
    for (let i = 1; i < 1000; i++) {
      const c = i === 1 ? n : `${n} (${i})`;
      const dir = path.join(this.root, c);
      const st = lstat(dir);
      if (!st) return { name: n, free: c };
      if (!st.isDirectory()) continue;
      const own = readManifest(path.join(dir, MANIFEST));
      if ((id && own?.id === id) || isEmpty(dir)) return { name: n, free: c };
    }
    return { name: n, free: '' };
  }

  /** May the model file be saved as `rel` in its folder: nothing there yet, or the file SOMA wrote there. */
  async mayWrite(folder: string, rel: string): Promise<boolean> {
    const m = readManifest(path.join(folder, MANIFEST));
    return (await owner(path.join(folder, rel), m?.files[rel])) !== 'other';
  }

  private take(): { model: MirrorModel; save?: MirrorSave } | null {
    const first = this.queue.entries().next();
    if (first.done) return null;
    this.queue.delete(first.value[0]);
    return first.value[1];
  }

  private async run(asked: MirrorModel, save?: MirrorSave): Promise<void> {
    const claimed = this.claimed.get(asked.id);
    const model = claimed ? { ...asked, name: claimed } : asked;
    let folder: string | null = null;
    let m: Manifest | null = null;
    let notice: string | undefined;
    const problems: string[] = [];
    try {
      const found = await this.folderFor(model);
      folder = found.dir;
      notice = found.notice;
      const known = readManifest(path.join(folder, MANIFEST));
      const mf: Manifest = known?.id === model.id ? { ...known, files: { ...known.files }, kept: { ...known.kept } } : { id: model.id, files: {}, kept: {} };
      mf.name = model.name;
      mf.folder = path.basename(folder);
      m = mf;
      if (!known) this.writeManifest(folder, mf); // claims the folder before anything else is in it

      const soma = `${folderName(model.name)}.soma`;
      for (const { from, to } of SOURCES) {
        const base = path.join(model.dir, from);
        const list = listFiles(base, from);
        if (list.problem) problems.push(list.problem);
        for (const rel of list.files) {
          if (!to && RESERVED.has(rel.split('/')[0])) continue;
          // Names the folder gives its own files: the model file, the new file next to one the user changed
          if ((!to && rel === soma) || rel.includes(' (from SOMA)')) continue;
          // One file that cannot be written (something of the user in the way) does not stop the others
          try { await this.place(path.join(base, rel), folder, to ? `${to}/${rel}` : rel, mf); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
        }
      }
      if (save?.zipPath && lstat(save.zipPath)?.isFile()) {
        const zip = path.resolve(save.zipPath);
        // Saved right here (the folder is the model's home): only noted as SOMA's, never copied onto itself. Saved elsewhere
        // in the synced folder: the user has it there already, a second copy would only confuse
        if (zip === path.join(folder, soma)) await this.note(zip, soma, mf);
        else if (!this.opts.home || !below(this.root, zip)) await this.place(zip, folder, soma, mf);
      }
      if (save) {
        // The first time only noted: the results of an older save are not known any more
        if (mf.savedHead !== undefined && save.head && save.head !== mf.savedHead && save.zipPath && this.opts.versions) {
          problems.push(...await this.version(model, folder, save.head));
        }
        mf.savedHead = save.head;
      }
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
    // Also after an error: what was written is noted, so it does not count as the user's file next time
    if (folder && m) {
      try { this.writeManifest(folder, m); } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
    }
    const kept = Object.values(m?.kept ?? {});
    if (problems.length) {
      console.warn('[web] synced folder:', problems.join(' '));
      this.report({ folder, state: 'error', error: problems.join(' '), kept, notice });
    } else {
      this.report({ folder, state: 'ok', kept, syncedAt: Date.now(), notice });
    }
  }

  private report(s: MirrorStatus): void {
    this.last = s;
    this.opts.onStatus?.(s);
  }

  /** Written as a whole (a temporary file renamed), so a crash leaves the old one, and never through a link. */
  private writeManifest(folder: string, m: Manifest): void {
    const tmp = path.join(folder, tmpName());
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), { flag: 'wx' });
    fs.renameSync(tmp, path.join(folder, MANIFEST));
  }

  /**
   * The folder of a model: its name, unless that folder belongs to another model (or to the user: a folder with something
   * in it and without our file). Then the name with a number, "<name> (2)". A folder of the user that holds the model
   * file (`model.file`, opened from there) is taken, nothing of the user's is overwritten in it (place).
   *
   * As the models' home, a renamed model (the manifest has the old name) takes its folder along, renamed, when the folder still has the name
   * SOMA gave it and everything in it is SOMA's: the files it wrote, versions/, the manifest. Otherwise the old folder stays
   * as it is, a new one is made and `notice` says so. Otherwise a renamed model always gets a new folder.
   */
  private async folderFor(model: MirrorModel, opts: { moveFile?: boolean } = {}): Promise<{ dir: string; notice?: string }> {
    fs.mkdirSync(this.root, { recursive: true });
    // The sync may bring a link in place of the folder itself: nothing is written through it
    if (!lstat(this.root)?.isDirectory()) throw new Error(`${this.root} is not a folder (a link?): nothing written through it.`);
    const name = folderName(model.name);
    const own = this.ownFolders(model.id, name);
    const here = own.find((o) => path.basename(o.dir) === name) ?? own.find((o) => isNameOf(path.basename(o.dir), name));
    if (here) { this.known.set(model.id, here.dir); return { dir: here.dir }; }

    const target = this.freeFolder(name, model.id, model.file);
    // The folder of the model under its previous name, as SOMA named it (not one the user renamed or copied)
    const prev = !this.opts.home ? undefined : own.filter((o) => o.m.name !== undefined && o.m.name !== model.name && o.m.folder === path.basename(o.dir))
      .sort((a, b) => b.mtime - a.mtime)[0];
    let notice: string | undefined;
    if (prev) {
      const ours = await this.onlyOurs(prev.dir, prev.m);
      if (ours && !lstat(target)) {
        fs.renameSync(prev.dir, target);
        if (opts.moveFile && prev.m.name) this.moveModelFile(target, prev.m, `${folderName(prev.m.name)}.soma`, `${path.basename(target)}.soma`);
        this.known.set(model.id, target);
        return { dir: target };
      }
      notice = `The folder "${path.basename(prev.dir)}" stays as it is: ${ours ? `there is a folder "${path.basename(target)}" already` : 'it has files that are not SOMA\'s'}. `
        + `The model "${model.name}" now has the folder "${path.basename(target)}".`;
    }
    if (!lstat(target)) fs.mkdirSync(target);
    this.known.set(model.id, target);
    return { dir: target, notice };
  }

  /** Folders of the model (their manifest has its ID): where it was found last when that fits the name, else all at the top. */
  private ownFolders(id: string, name: string): { dir: string; m: Manifest; mtime: number }[] {
    const read = (dir: string) => {
      if (!lstat(dir)?.isDirectory()) return null;
      const file = path.join(dir, MANIFEST);
      const m = readManifest(file);
      return m?.id === id ? { dir, m, mtime: lstat(file)?.mtimeMs ?? 0 } : null;
    };
    const cached = this.known.get(id);
    const hit = cached ? read(cached) : null;
    if (hit && isNameOf(path.basename(hit.dir), name)) return [hit];
    let names: string[];
    try { names = fs.readdirSync(this.root); } catch { return []; }
    return names.filter((n) => !n.startsWith('.')).map((n) => read(path.join(this.root, n))).filter((o) => !!o);
  }

  /**
   * The first of "<name>", "<name> (2)", … that does not exist yet, is empty, or is a folder of the user with the model
   * file. Without the model folders as home (opts.home) only "<name>" and "<name> (<start of the ID>)", as before.
   */
  private freeFolder(name: string, id: string, file?: string | null): string {
    const holder = file ? path.dirname(path.resolve(file)) : null;
    const max = this.opts.home ? 1000 : 3;
    for (let i = 1; i < max; i++) {
      const dir = path.join(this.root, i === 1 ? name : this.opts.home ? `${name} (${i})` : `${name} (${id.slice(0, 8)})`);
      const st = lstat(dir);
      if (!st) return dir;
      // A manifest of another model, or one that cannot be read (changed by the user, a link): not ours to replace
      if (!st.isDirectory() || lstat(path.join(dir, MANIFEST))) continue;
      if (isEmpty(dir) || dir === holder) return dir;
    }
    throw new Error(`No folder for "${name}" in ${this.root}: ${this.opts.home ? `"${name}" up to "${name} (999)" belong` : `"${name}" and "${name} (${id.slice(0, 8)})" belong`} to something else.`);
  }

  /** Is everything in the folder SOMA's: files it wrote (unchanged), versions/, the manifest, temporary files of its own? */
  private async onlyOurs(dir: string, m: Manifest): Promise<boolean> {
    const walk = async (rel: string): Promise<boolean> => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return false; }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.name.startsWith(TMP_PREFIX) || (!rel && e.name === MANIFEST && e.isFile()) || (!rel && e.name === 'versions' && e.isDirectory())) continue;
        if (e.isDirectory()) { if (!(await walk(r))) return false; continue; }
        if (!e.isFile() || (await owner(path.join(dir, r), m.files[r])) !== 'ours') return false;
      }
      return true;
    };
    return walk('');
  }

  /** <old name>.soma, SOMA's own, renamed to <new name>.soma in the folder (only when that is not there). */
  private moveModelFile(dir: string, m: Manifest, from: string, to: string): void {
    const rec = m.files[from];
    if (from === to || !rec || !lstat(path.join(dir, from))?.isFile() || lstat(path.join(dir, to))) return;
    fs.renameSync(path.join(dir, from), path.join(dir, to));
    const files = { ...m.files, [to]: rec };
    delete files[from];
    this.writeManifest(dir, { ...m, files });
  }

  /** The model file saved right in the folder: noted as SOMA's (what it is now), so it never counts as the user's. */
  private async note(file: string, rel: string, m: Manifest): Promise<void> {
    const st = fs.statSync(file);
    const rec = m.files[rel];
    if (!rec || rec.srcSize !== st.size || rec.srcMtime !== st.mtimeMs) m.files[rel] = { srcSize: st.size, srcMtime: st.mtimeMs, hash: await hashFile(file) };
    delete m.kept?.[rel];
  }

  /** Copies one file into the folder when the model has a new one. A file there the user changed stays (see above). */
  private async place(src: string, folder: string, rel: string, m: Manifest): Promise<void> {
    const st = fs.statSync(src);
    const unchanged = (r: string) => { const rec = m.files[r]; return !!rec && rec.srcSize === st.size && rec.srcMtime === st.mtimeMs; };
    const kept = m.kept ??= {};
    if (unchanged(rel)) {
      // Nothing new. A note about a changed file lasts while the user's file is there
      if (kept[rel] && !lstat(path.join(folder, ...rel.split('/')))) delete kept[rel];
      return;
    }
    const dest = prepareDir(folder, rel);
    if ((await owner(dest, m.files[rel])) !== 'other') {
      // Ours or missing (deleted by the user: back with this new result)
      await this.write(src, dest, rel, st, m);
      delete kept[rel];
      return;
    }
    // The user's file (changed or put there): it stays, the new one goes next to it, unless the user changed that too
    const copy = copyName(rel);
    const copyDest = prepareDir(folder, copy);
    const updated = (await owner(copyDest, m.files[copy])) !== 'other';
    if (updated && !(unchanged(copy) && lstat(copyDest))) await this.write(src, copyDest, copy, st, m);
    kept[rel] = { file: rel, copy, updated };
  }

  private async write(src: string, dest: string, rel: string, st: fs.Stats, m: Manifest): Promise<void> {
    const hash = await copyAtomic(src, dest);
    m.files[rel] = { srcSize: st.size, srcMtime: st.mtimeMs, hash };
  }

  /**
   * versions/<date> <message>/: the results as they are at this save. Made in a temporary folder and renamed, so a
   * failure leaves no half version. The model file itself is not repeated there: the one at the top holds every version.
   */
  private async version(model: MirrorModel, folder: string, head: string): Promise<string[]> {
    const subject = folderName(await commitSubject(model.dir, head), '').slice(0, 60);
    const base = `${stamp(new Date())} ${subject || head.slice(0, 7)}`;
    prepareDir(folder, 'versions/-');
    const versions = path.join(folder, 'versions');
    const tmp = path.join(versions, tmpName());
    const problems: string[] = [];
    try {
      fs.mkdirSync(tmp);
      for (const { from, to } of SOURCES) {
        const src = path.join(model.dir, from);
        const list = listFiles(src, from);
        if (list.problem) problems.push(`Version ${base}: ${list.problem}`);
        for (const rel of list.files) {
          if (!to && RESERVED.has(rel.split('/')[0])) continue;
          const r = to ? `${to}/${rel}` : rel;
          try { fs.copyFileSync(path.join(src, rel), prepareDir(tmp, r), fs.constants.COPYFILE_EXCL); } catch (e) {
            // Gone since the listing (an agent replacing its renders): the version without it, not no version
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
      }
      let dir = path.join(versions, base);
      for (let i = 2; lstat(dir); i++) dir = path.join(versions, `${base} (${i})`);
      fs.renameSync(tmp, dir);
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nothing left */ }
      throw e;
    }
    return problems;
  }
}
