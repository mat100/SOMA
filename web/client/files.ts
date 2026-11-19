import { icon } from '../../app/src/renderer/icons';
import { ask, el, toast } from '../../app/src/renderer/ui';
import type { OpenDialogOptions, SaveDialogOptions } from '../../app/src/main/platform';
import type { DirListing, OpenAnswer, SaveAnswer } from '../shared/files';
import type { WsTransport } from './transport';

/*
 * The file dialogs of the browser version, in place of the dialogs of the system on the desktop. The models live on the
 * server: opening offers an upload from this computer or a file on the server; saving offers a download or a place on
 * the server. Built like the questions of the app (ui.ts ask), with its styles.
 */

/**
 * `mkdir`: the folder browser can make folders. `browseFirst`: straight into the folder browser (opening a model, where
 * the synced folder is the models' home). `model`: Save as of the model in its folder (web/server/main.ts).
 */
type OpenReq = OpenDialogOptions & { root: string; mkdir?: boolean; browseFirst?: boolean };
type SaveReq = SaveDialogOptions & { name: string; root: string; mkdir?: boolean; model?: { name: string; folder: string } };

/** The message of an error from the server, without the wrapping of the transport. */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const randomHex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Uploads files into one batch on the server, the paths there. Fails with the first file that cannot go up. */
export async function upload(files: File[]): Promise<string[]> {
  const batch = randomHex(12);
  const paths: string[] = [];
  for (const f of files) {
    // A dropped folder arrives as an empty File that cannot be read
    if (!f.size && !f.type && !(await readable(f))) throw new Error(`${f.name} is a folder. In the browser, drop or choose files (or a ZIP of the folder).`);
    const r = await fetch(`upload?batch=${batch}&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!r.ok) throw new Error(`${f.name} could not be uploaded: ${(await r.text().catch(() => '')) || r.statusText}`);
    paths.push(((await r.json()) as { path: string }).path);
  }
  return paths;
}

const readable = (f: File) => f.slice(0, 1).arrayBuffer().then(() => true, () => false);

/** Dialogs that are open: they end (as canceled) when the connection to the server is lost, their answer would go nowhere. */
const open = new Set<() => void>();
export function closeDialogs(): void { for (const close of [...open]) close(); }

/** A dialog box in the style of the app's questions. Escape and the last button cancel. */
function dialog(title: string, ...body: (HTMLElement | null)[]): { box: HTMLElement; close: () => void; onClose: (cb: () => void) => void } {
  const before = document.activeElement as HTMLElement | null;
  const box = el('div', { className: 'ask-dlg web-files' }, el('div', { className: 'ask-title' }, title), ...body);
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  const scrim = el('div', { className: 'ask-scrim' }, box);
  let closed: () => void = () => {};
  // Only the dialog on top (a name asked above the folder browser)
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && [...open].at(-1) === close) { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
  function close(): void {
    open.delete(close);
    window.removeEventListener('keydown', onKey, true);
    scrim.remove();
    before?.focus?.();
    closed();
  }
  window.addEventListener('keydown', onKey, true);
  document.body.append(scrim);
  open.add(close);
  return { box, close, onClose: (cb) => { closed = cb; } };
}

const button = (label: string, primary: boolean, onclick: () => void) => el('button', { className: primary ? 'btn primary' : 'btn', textContent: label, onclick });
/** Extensions the dialog shows, empty for any file (no filters, or "All files" among them). */
const extensions = (o: { filters?: { extensions: string[] }[] }) => {
  const all = (o.filters ?? []).flatMap((f) => f.extensions);
  return all.includes('*') ? [] : all;
};

/** What the server says about a model name (web:modelName): the name as a folder name, the first free one ('' none). */
interface NameCheck { name: string; free: string }

/**
 * Asks for a name: Enter or the first button takes it. `check` may refuse it with a message, and may put a better name in
 * the field (Enter again takes that one). The name as `check` returned it, null when canceled.
 */
export function askName(o: { title: string; message: string; value: string; ok: string; check: (v: string) => Promise<{ value: string } | { error: string; value?: string }> }): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const input = el('input', { className: 'web-name', type: 'text', value: o.value, spellcheck: false }) as HTMLInputElement;
    input.setAttribute('aria-label', 'Name');
    const note = el('div', { className: 'ask-detail web-error' });
    note.setAttribute('role', 'alert');
    let busy = false;
    const take = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await o.check(input.value);
        if ('error' in r) {
          note.textContent = r.error;
          if (r.value !== undefined) input.value = r.value;
          input.focus();
          return;
        }
        if (answered) return;
        answered = true;
        d.close();
        resolve(r.value);
      } catch (e) { note.textContent = message(e); } finally { busy = false; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void take(); } });
    const d = dialog(o.title, el('div', { className: 'ask-msg' }, o.message), input, note,
      el('div', { className: 'ask-btns' }, button(o.ok, true, () => void take()), button('Cancel', false, () => d.close())));
    d.onClose(() => { if (!answered) { answered = true; resolve(null); } });
    input.focus();
    input.select();
  });
}

/**
 * The name of a model in the models' home (web:modelName): taken when its folder is free, otherwise the first free name is
 * offered. `current`: the open model under a new name (its own folder counts as free).
 */
export function askModelName(t: WsTransport, o: { title: string; message: string; value: string; ok: string; current?: boolean }): Promise<string | null> {
  return askName({ ...o, check: (v) => checkModelName(t, v, !!o.current) });
}

async function checkModelName(t: WsTransport, v: string, current: boolean): Promise<{ value: string } | { error: string; value?: string }> {
  const r = await t.invoke('web:modelName', v, current) as NameCheck;
  if (!r.name) return { error: 'Enter a name. It is also the name of the model\'s folder.' };
  if (r.free === r.name) return { value: r.name };
  if (!r.free) return { error: `There are folders "${r.name}" up to "${r.name} (999)" already. Choose another name.` };
  return { error: `There is a folder "${r.name}" already (another model, or files of yours). Press Enter for "${r.free}", or type another name.`, value: r.free };
}

/** Open: upload from this computer, or a file or folder on the server. */
export function openDialog(t: WsTransport, o: OpenReq): Promise<OpenAnswer> {
  if (o.browseFirst) {
    // The models' home: the folder browser at once, uploading is one of its buttons
    const exts = extensions(o);
    return serverBrowser(t, { title: o.title, root: o.root, start: o.defaultPath ?? o.root, pickDirs: false, exts, mkdir: o.mkdir, upload: { many: o.properties.includes('multiSelections'), exts } })
      .then((p) => (p === null ? null : typeof p === 'string' ? { kind: 'server', paths: [p] } : { kind: 'upload', paths: p }));
  }
  return new Promise((resolve) => {
    const dirs = o.properties.includes('openDirectory');
    const many = o.properties.includes('multiSelections');
    const exts = extensions(o);
    let answered = false;
    const answer = (a: OpenAnswer) => { if (answered) return; answered = true; d.close(); resolve(a); };
    const msg = el('div', { className: 'ask-detail' });
    const input = el('input', { type: 'file', hidden: true, multiple: many, accept: exts.map((e) => `.${e}`).join(',') }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const list = [...(input.files ?? [])];
      if (!list.length) return;
      msg.textContent = `Uploading ${list.length === 1 ? list[0].name : `${list.length} files`} …`;
      try { answer({ kind: 'upload', paths: await upload(list) }); } catch (e) { msg.textContent = e instanceof Error ? e.message : String(e); }
    });
    const browse = () => void serverBrowser(t, { title: o.title, root: o.root, start: o.defaultPath ?? o.root, pickDirs: dirs, exts, mkdir: o.mkdir }).then((p) => { if (typeof p === 'string') answer({ kind: 'server', paths: [p] }); });
    const btns: HTMLElement[] = [];
    let text: string;
    if (dirs && o.forExport) {
      text = 'Download the exported files to this computer as a ZIP, or save them in a folder on the server.';
      btns.push(button('Download', true, () => answer({ kind: 'download' })), button('Choose a folder on the server …', false, browse));
    } else if (dirs) {
      text = 'Choose a folder on the server.';
      btns.push(button('Choose a folder on the server …', true, browse));
    } else {
      text = `Upload ${many ? 'files' : 'a file'} from this computer, or choose ${many ? 'one' : 'it'} on the server.`;
      btns.push(button('Upload from this computer …', true, () => input.click()), button('Choose on the server …', false, browse));
    }
    btns.push(button('Cancel', false, () => answer(null)));
    const d = dialog(o.title, el('div', { className: 'ask-msg' }, text), msg, input, el('div', { className: 'ask-btns' }, ...btns));
    d.onClose(() => { if (!answered) { answered = true; resolve(null); } });
    btns[0].focus();
  });
}

/** Save: download to this computer, or a place on the server. */
export function saveDialog(t: WsTransport, o: SaveReq): Promise<SaveAnswer> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (a: SaveAnswer) => { if (answered) return; answered = true; d.close(); resolve(a); };
    const name = el('input', { className: 'web-name', type: 'text', value: o.name, spellcheck: false }) as HTMLInputElement;
    name.setAttribute('aria-label', 'File name');
    const model = o.model;
    if (model) name.value = model.name;
    // In the model's folder the field holds the model name, the file is <name>.soma
    const fileName = () => (model ? `${name.value.trim() || model.name}.soma` : name.value.trim() || o.name);
    const onServer = () => void serverBrowser(t, { title: o.title, root: o.root, start: o.defaultPath ?? o.root, pickDirs: true, exts: [], saveName: fileName(), mkdir: o.mkdir })
      .then(async (dir) => {
        if (typeof dir !== 'string') return;
        // As the dialog of the system: ask before replacing a file that is there
        const there = await t.invoke('web:listDir', dir).then((l) => (l as DirListing).entries.some((e) => !e.dir && e.name === fileName()), () => false);
        if (there && (await ask({ title: o.title, message: `${fileName()} already exists. Replace it?`, buttons: ['Replace', 'Cancel'] })) !== 0) return;
        answer({ kind: 'server', path: `${dir.replace(/[\\/]$/, '')}/${fileName()}` });
      });
    const download = () => answer({ kind: 'download', name: fileName() });
    const note = el('div', { className: 'ask-detail web-error' });
    note.setAttribute('role', 'alert');
    // Save as in the model's folder: the name is checked as for a new model (its own folder counts as free)
    let checking = false;
    const inFolder = async () => {
      if (!model || checking) return;
      checking = true;
      try {
        const r = await checkModelName(t, name.value, true);
        if ('value' in r && !('error' in r)) { answer({ kind: 'model', name: r.value }); return; }
        note.textContent = r.error;
        if (r.value !== undefined) name.value = r.value;
      } catch (e) { note.textContent = message(e); } finally { checking = false; }
    };
    const btns = model
      ? [button('Save', true, () => void inFolder()), button('Save elsewhere on the server …', false, onServer), button('Download', false, download), button('Cancel', false, () => answer(null))]
      : [button('Download', true, download), button('Save on the server …', false, onServer), button('Cancel', false, () => answer(null))];
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (model) void inFolder(); else download(); } });
    const text = model
      ? `The model is saved in its folder ${model.folder}. Under a new name it moves to a folder of that name.`
      : 'Download to this computer, or save on the server.';
    name.setAttribute('aria-label', model ? 'Model name' : 'File name');
    const d = dialog(o.title, el('div', { className: 'ask-msg' }, text), name, note, el('div', { className: 'ask-btns' }, ...btns));
    d.onClose(() => { if (!answered) { answered = true; resolve(null); } });
    name.focus();
    name.setSelectionRange(0, model ? name.value.length : name.value.replace(/\.[^.]*$/, '').length);
  });
}

/** `mkdir`: a button for a new folder. `upload`: a button to upload from this computer instead. */
interface BrowseOptions {
  title: string; root: string; start: string; pickDirs: boolean; exts: string[]; saveName?: string; mkdir?: boolean;
  upload?: { many: boolean; exts: string[] };
}

/** Folders and files on the server below the root. A folder (pickDirs) or a file, the uploaded files, null when canceled. */
function serverBrowser(t: WsTransport, o: BrowseOptions): Promise<string | string[] | null> {
  return new Promise((resolve) => {
    let answered = false;
    let cur: DirListing | null = null;
    const answer = (p: string | string[] | null) => { if (answered) return; answered = true; d.close(); resolve(p); };
    const where = el('div', { className: 'ask-detail web-where' });
    const list = el('div', { className: 'web-list', tabIndex: 0 });
    const ok = button(o.saveName ? `Save here as ${o.saveName}` : 'Choose this folder', true, () => { if (cur) answer(cur.dir); });
    ok.hidden = !o.pickDirs;
    const up = button('Up', false, () => { if (cur?.parent) void show(cur.parent); });
    const extra: HTMLElement[] = [];
    if (o.mkdir) {
      extra.push(button('New folder', false, () => {
        const c = cur;
        if (!c) return;
        void askName({
          title: 'New folder', message: `A new folder in ${c.dir}.`, value: 'New folder', ok: 'Create',
          check: async (v) => { try { return { value: await t.invoke('web:mkdir', c.dir, v) as string }; } catch (e) { return { error: message(e) }; } },
        }).then((dir) => { if (dir) void show(dir); });
      }));
    }
    if (o.upload) {
      const input = el('input', { type: 'file', hidden: true, multiple: o.upload.many, accept: o.upload.exts.map((e) => `.${e}`).join(',') }) as HTMLInputElement;
      input.addEventListener('change', async () => {
        const files = [...(input.files ?? [])];
        if (!files.length) return;
        where.textContent = `Uploading ${files.length === 1 ? files[0].name : `${files.length} files`} …`;
        try { answer(await upload(files)); } catch (e) { where.textContent = message(e); }
      });
      extra.push(button('Upload from this computer …', false, () => input.click()), input);
    }
    const show = async (dir: string) => {
      try { cur = await t.invoke('web:listDir', dir) as DirListing; } catch (e) { where.textContent = e instanceof Error ? e.message : String(e); return; }
      const c = cur;
      where.textContent = c.dir === c.root ? c.dir : `${c.dir}`;
      up.toggleAttribute('disabled', !c.parent);
      const rows = c.entries
        .filter((e) => e.dir || (!o.pickDirs && (!o.exts.length || o.exts.some((x) => e.name.toLowerCase().endsWith(`.${x.toLowerCase()}`)))))
        .map((e) => {
          const row = el('button', { className: 'mi web-row' }, icon(e.dir ? 'folder' : 'file', 15), el('span', { textContent: e.name }));
          const abs = `${c.dir.replace(/[\\/]$/, '')}/${e.name}`;
          row.addEventListener('click', () => (e.dir ? void show(abs) : answer(abs)));
          return row;
        });
      list.replaceChildren(...(rows.length ? rows : [el('div', { className: 'c3 web-empty', textContent: o.pickDirs ? 'No folders here.' : 'Nothing to open here.' })]));
    };
    const d = dialog(o.title, where, list, el('div', { className: 'ask-btns' }, up, ...extra, ok, button('Cancel', false, () => answer(null))));
    d.onClose(() => { if (!answered) { answered = true; resolve(null); } });
    void show(o.start);
  });
}

/** Lets the browser save a file the server offers (a download link of files.ts). */
function download(url: string, name: string): void {
  const a = el('a', { href: url, download: name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
}

const CSS = `
.web-files { width:min(560px, 100%); }
.web-name { width:100%; padding:6px 8px; border-radius:6px; border:1px solid var(--line2); background:var(--s2); color:var(--tx); font:inherit; }
.web-where { font-family:var(--mono); font-size:12px; }
.web-list { display:flex; flex-direction:column; max-height:min(50vh, 420px); overflow:auto; border:1px solid var(--line); border-radius:8px; padding:4px; background:var(--s2); }
.web-row { display:flex; align-items:center; gap:8px; width:100%; padding:5px 8px; border-radius:6px; text-align:left; }
.web-row:hover { background:var(--s3); }
.web-empty { padding:10px; }
.web-error { color:var(--warn); }
.web-error:empty { display:none; }
`;

/** Registers the dialogs and downloads the server asks for. */
export function fileRequests(t: WsTransport): void {
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.append(s);
  t.onRequest('web:openDialog', (o) => openDialog(t, o as OpenReq));
  t.onRequest('web:saveDialog', (o) => saveDialog(t, o as SaveReq));
  t.onRequest('web:download', (url, name) => download(String(url), String(name)));
}

/** Paths on the server for dropped files (Transport.filePaths): they are uploaded first. */
export async function uploadDropped(files: File[]): Promise<string[]> {
  try { return await upload(files); } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
    return [];
  }
}
