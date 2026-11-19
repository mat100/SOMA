// What only the web version has, in a real browser: the file dialogs of the page, files dropped from the computer, a lost
// connection, another tab taking over, the Alt shortcuts and the question when closing the tab. The server runs outside
// test mode, so dialogs go to the page as for a user. Run with `npm run test:browser` (after `npm run build`).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'browser-test-token';
let server: ChildProcess;
let base: string;
let userData: string;
let filesRoot: string;
let mirrorDir: string;
let browser: Browser;
let context: BrowserContext;
/** A second server whose synced folder is also the folder of the dialogs: the models' home (server/main.ts modelHome). */
const home = { server: null as ChildProcess | null, base: '', userData: '', root: '', context: null as BrowserContext | null };

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 30_000) => {
  for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 200))) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${what}`);
  }
};

/** Starts a server, resolves once it listens. */
async function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; base: string }> {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(WEB, 'bin', 'soma-web.cjs')], {
    env: { ...process.env, SOMA_TEST: undefined, SOMA_WEB_PORT: String(port), SOMA_WEB_TOKEN: TOKEN, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${log}`)), 30_000);
    const on = (d: Buffer) => { log += d; if (log.includes('[web] SOMA')) { clearTimeout(timer); resolve(); } };
    proc.stdout!.on('data', on);
    proc.stderr!.on('data', on);
  });
  return { proc, base: `http://127.0.0.1:${port}/` };
}

before(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-web-browser-'));
  filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-web-browser-files-'));
  mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-web-browser-mirror-'));
  fs.mkdirSync(path.join(filesRoot, 'models'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}/`;
  server = spawn(process.execPath, [path.join(WEB, 'bin', 'soma-web.cjs')], {
    env: { ...process.env, SOMA_TEST: undefined, SOMA_WEB_PORT: String(port), SOMA_WEB_TOKEN: TOKEN, SOMA_USER_DATA: userData, SOMA_WEB_FILES: filesRoot,
      SOMA_MIRROR_DIR: mirrorDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${log}`)), 30_000);
    const on = (d: Buffer) => { log += d; if (log.includes('[web] SOMA')) { clearTimeout(timer); resolve(); } };
    server.stdout!.on('data', on);
    server.stderr!.on('data', on);
  });
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  context = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
  // The cookie for all pages of the context
  const login = await context.newPage();
  await login.goto(`${base}?token=${TOKEN}`);
  await login.close();
});

after(async () => {
  await browser?.close();
  server?.kill('SIGKILL');
  home.server?.kill('SIGKILL');
  for (const d of [home.userData, home.root]) if (d) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(filesRoot, { recursive: true, force: true });
  fs.rmSync(mirrorDir, { recursive: true, force: true });
});

/** A page of SOMA, loaded and listening. */
async function open(): Promise<Page> {
  const p = await context.newPage();
  await p.goto(base);
  await p.waitForFunction(() => !!window.soma && !document.getElementById('boot'));
  return p;
}

/** The open model of the page, built. A new one when `fresh` or when none is open. */
async function model(p: Page, fresh = false): Promise<{ id: string; dir: string; name: string }> {
  const cur = await p.evaluate(() => window.soma.project.current().catch(() => null));
  if (fresh || !cur) {
    // On the start page through its button (it closes the page), with a model open through the API
    const start = p.locator('#start-new:visible, #start-empty-new:visible').first();
    if (await start.count()) await start.click(); else await p.evaluate(() => window.soma.project.create());
    await until('new model shown', async () => p.evaluate((old) => window.soma.project.current().then((c) => c.id !== old, () => false), cur?.id ?? null), 60_000);
  }
  await p.waitForFunction(() => document.getElementById('status')!.textContent === 'Built' && document.getElementById('start')!.hidden, null, { timeout: 120_000 });
  return p.evaluate(() => window.soma.project.current());
}

const dialog = (p: Page) => p.locator('.web-files');
const button = (p: Page, scope: string, name: string | RegExp) => p.locator(scope).getByRole('button', { name });

test('save on the server: folder browser, file written there, asks before replacing', async () => {
  const p = await open();
  await model(p, true);
  const saving = p.evaluate(() => window.soma.project.save(true));
  await button(p, '.web-files', 'Save on the server …').click();
  await dialog(p).getByRole('button', { name: 'models' }).click();
  await button(p, '.web-files', /^Save here as/).click();
  const r = await saving as { cancelled: boolean; error?: string };
  assert.equal(r.cancelled, false);
  assert.equal(r.error, undefined);
  const file = path.join(filesRoot, 'models', 'New model.soma');
  assert.ok(fs.existsSync(file), 'the model file is on the server');
  // The same name again: the page asks, Cancel keeps the file as it is
  const before = fs.statSync(file).mtimeMs;
  const again = p.evaluate(() => window.soma.project.save(true));
  await button(p, '.web-files', 'Save on the server …').click();
  // As the dialog of the system, the browser starts where the model was saved last
  await p.locator('.web-where').getByText(path.join(filesRoot, 'models')).waitFor();
  await button(p, '.web-files', /^Save here as/).click();
  // The app's question (alertdialog), above the folder browser (dialog)
  const question = p.getByRole('alertdialog');
  await question.getByText('already exists. Replace it?').waitFor();
  await question.getByRole('button', { name: 'Cancel' }).click();
  // Back in the folder browser: cancel it too
  await button(p, '.web-files', 'Cancel').last().click();
  assert.equal((await again as { cancelled: boolean }).cancelled, true);
  assert.equal(fs.statSync(file).mtimeMs, before, 'not replaced');
  await p.close();
});

test('open a model file from the server', async () => {
  const p = await open();
  await model(p);
  const opening = p.evaluate(() => window.soma.project.openZip());
  await button(p, '.web-files', 'Choose on the server …').click();
  await dialog(p).getByRole('button', { name: 'models' }).click();
  await dialog(p).getByRole('button', { name: 'New model.soma' }).click();
  // The open model is the one in the file already: SOMA may ask what to do with the working copy
  const asked = await p.getByRole('alertdialog').waitFor({ timeout: 5000 }).then(() => true, () => false);
  if (asked) await p.getByRole('alertdialog').locator('.btn.primary').click();
  const r = await opening as { error?: string } | null;
  assert.equal(r?.error, undefined);
  await p.waitForFunction(() => document.getElementById('doc-name')!.textContent === 'New model');
  await p.close();
});

test('export into a folder on the server', async () => {
  const p = await open();
  await model(p);
  fs.mkdirSync(path.join(filesRoot, 'exports'), { recursive: true });
  const exporting = p.evaluate(() => window.soma.build.export('step', null));
  await button(p, '.web-files', 'Choose a folder on the server …').click();
  await dialog(p).getByRole('button', { name: 'exports' }).click();
  await button(p, '.web-files', 'Choose this folder').click();
  const r = await exporting as { ok: boolean; files: string[] };
  assert.equal(r.ok, true);
  assert.deepEqual(fs.readdirSync(path.join(filesRoot, 'exports')).sort(), ['Body.step', 'Lid.step']);
  await p.close();
});

test('import: upload from this computer through the dialog', async () => {
  const p = await open();
  const m = await model(p);
  const src = path.join(os.tmpdir(), `soma-upload-${process.pid}.step`);
  fs.writeFileSync(src, 'ISO-10303-21;');
  const importing = p.evaluate(() => window.soma.fs.importPick());
  const chooser = p.waitForEvent('filechooser');
  await button(p, '.web-files', 'Upload from this computer …').click();
  await (await chooser).setFiles(src);
  const r = await importing as { files: string[] };
  assert.deepEqual(r.files, [`inputs/${path.basename(src)}`]);
  assert.equal(fs.readFileSync(path.join(m.dir, 'inputs', path.basename(src)), 'utf8'), 'ISO-10303-21;');
  fs.rmSync(src);
  await p.close();
});

test('drop files from the computer into the window: uploaded and imported', async () => {
  const p = await open();
  const m = await model(p);
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['solid a\nendsolid a\n'], 'dropped.stl', { type: 'model/stl' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await until('dropped file in inputs/', () => fs.existsSync(path.join(m.dir, 'inputs', 'dropped.stl')));
  assert.equal(fs.readFileSync(path.join(m.dir, 'inputs', 'dropped.stl'), 'utf8'), 'solid a\nendsolid a\n');
  await p.close();
});

test('a lost connection: the page says so, comes back by itself and gets what happened meanwhile', async () => {
  const p = await context.newPage();
  // Each WebSocket goes through here: the test cuts the line and keeps it down for a while, as a network would
  let current: { page: { close: () => Promise<void> }; server: { close: () => Promise<void> } } | null = null;
  let down = false;
  await p.routeWebSocket(/\/ws$/, (ws) => {
    if (down) { void ws.close({ code: 1006 as never, reason: 'down' }).catch(() => {}); return; }
    current = { page: ws, server: ws.connectToServer() };
  });
  await p.goto(base);
  await p.waitForFunction(() => !!window.soma && !document.getElementById('boot'));
  const m = await model(p);
  await p.evaluate(() => {
    const w = window as unknown as { __changes: number; __mark: number };
    w.__changes = 0;
    w.__mark = 1;
    window.soma.fs.onChanged(() => { w.__changes++; });
  });
  down = true;
  await current!.server.close();
  await current!.page.close();
  await p.locator('.web-banner').getByText('Reconnecting').waitFor();
  // While it is away: a file changes (the agent in a terminal, say). The server keeps the event for the page
  fs.writeFileSync(path.join(m.dir, 'meanwhile.md'), 'x');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await p.evaluate(() => (window as unknown as { __changes: number }).__changes), 0, 'nothing arrives while the line is down');
  down = false;
  await p.locator('.web-banner').waitFor({ state: 'detached', timeout: 20_000 });
  await until('the missed change arrives', async () => (await p.evaluate(() => (window as unknown as { __changes: number }).__changes)) > 0, 10_000);
  assert.equal(await p.evaluate(() => (window as unknown as { __mark: number }).__mark), 1, 'the same page, not reloaded');
  assert.ok((await p.evaluate(() => window.soma.fs.list())).some((f: { path: string }) => f.path === 'meanwhile.md'));
  await p.close();
});

test('a second tab takes over, the first one can take it back', async () => {
  const a = await open();
  await model(a);
  const b = await open();
  await a.locator('.web-stop').getByText('SOMA is open in another tab').waitFor();
  await b.waitForFunction(() => document.getElementById('status')!.textContent === 'Built', null, { timeout: 60_000 });
  assert.equal(await b.locator('.web-stop').count(), 0, 'the new tab works');
  await a.getByRole('button', { name: 'Use SOMA here' }).click();
  await b.locator('.web-stop').getByText('SOMA is open in another tab').waitFor();
  await a.waitForFunction(() => !!window.soma && !document.querySelector('.web-stop'));
  await a.close();
  await b.close();
});

test('Alt+1, Alt+2 and Alt+N do what Ctrl+1, Ctrl+2 and Ctrl+N do on the desktop', async () => {
  const p = await open();
  const m = await model(p);
  const side = () => p.evaluate(() => !document.getElementById('side')!.hidden);
  const code = () => p.evaluate(() => !document.getElementById('editor')!.hidden);
  await p.locator('#viewer').click({ position: { x: 5, y: 5 } }).catch(() => {});
  const s0 = await side();
  await p.keyboard.press('Alt+1');
  await until('sidebar toggled', async () => (await side()) !== s0, 5000);
  const c0 = await code();
  await p.keyboard.press('Alt+2');
  await until('code toggled', async () => (await code()) !== c0, 5000);
  await p.keyboard.press('Alt+2');
  await until('code back', async () => (await code()) === c0, 5000);
  await p.keyboard.press('Alt+N');
  await until('a new model', async () => (await p.evaluate(() => window.soma.project.current())).id !== m.id, 60_000);
  await p.close();
});

test('closing the tab asks only with text not yet saved in the editor', async () => {
  const p = await open();
  await model(p);
  let asked = 0;
  p.on('dialog', (d) => { if (d.type() === 'beforeunload') asked++; void d.accept(); });
  // Nothing typed: the tab closes without a question
  const quiet = await open();
  let quietAsked = 0;
  quiet.on('dialog', (d) => { if (d.type() === 'beforeunload') quietAsked++; void d.accept(); });
  await quiet.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(quietAsked, 0);
  // The page that took over: type into the editor without saving
  await p.reload();
  await p.waitForFunction(() => !!window.soma && !document.getElementById('boot'));
  await model(p);
  await p.keyboard.press('Alt+2');
  await p.locator('#code-view .cm-content').click();
  await p.keyboard.type('# not saved yet\n');
  await p.close({ runBeforeUnload: true });
  await until('beforeunload dialog', () => asked === 1, 5000);
});

test('synced folder: a STEP the user changed there stays, the page says where the new one is', async () => {
  const p = await open();
  const m = await model(p, true);
  // Its folder: the name, or the name with the start of the ID when an earlier test took it (mirror.ts)
  const own = () => fs.readdirSync(mirrorDir).find((n) => {
    try { return JSON.parse(fs.readFileSync(path.join(mirrorDir, n, '.soma-mirror.json'), 'utf8')).id === m.id; } catch { return false; }
  });
  await until('STEP in the synced folder', () => { const n = own(); return !!n && fs.existsSync(path.join(mirrorDir, n, 'model.step')); }, 60_000);
  const folder = path.join(mirrorDir, own()!);
  const step = path.join(folder, 'model.step');
  fs.writeFileSync(step, 'changed on the computer of the user');
  await p.evaluate(() => window.soma.build.run());
  await until('copy next to it', () => fs.existsSync(path.join(folder, 'model (from SOMA).step')), 60_000);
  assert.equal(fs.readFileSync(step, 'utf8'), 'changed on the computer of the user');
  const note = p.locator('.web-note');
  await note.waitFor({ timeout: 15_000 });
  assert.match(await note.textContent() ?? '', /model\.step → model \(from SOMA\)\.step/);
  await note.getByRole('button', { name: 'Close' }).click();
  assert.equal(await note.count(), 0);
  // The same again after the next build (a new STEP next to it): not shown once more
  const copy = path.join(folder, 'model (from SOMA).step');
  const before = fs.statSync(copy).mtimeMs;
  await p.evaluate(() => window.soma.build.run());
  await until('copy updated', () => fs.statSync(copy).mtimeMs !== before, 60_000);
  await p.waitForTimeout(500); // the status message after the copy
  assert.equal(await note.count(), 0);
  await p.close();
});

// ---- The synced folder as the models' home (SOMA_WEB_FILES = SOMA_MIRROR_DIR, as in a Coder workspace) ----------------

/** A page of the second server, its own browser context (the login cookie does not tell ports apart). */
async function openHome(): Promise<Page> {
  if (!home.server) {
    home.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-web-home-'));
    home.root = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-web-home-files-'));
    const s = await startServer({ SOMA_USER_DATA: home.userData, SOMA_WEB_FILES: home.root, SOMA_MIRROR_DIR: home.root });
    home.server = s.proc;
    home.base = s.base;
    home.context = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
    const login = await home.context.newPage();
    await login.goto(`${home.base}?token=${TOKEN}`);
    await login.close();
  }
  const p = await home.context!.newPage();
  await p.goto(home.base);
  await p.waitForFunction(() => !!window.soma && !document.getElementById('boot'));
  return p;
}

const built = (p: Page) => p.waitForFunction(() => document.getElementById('status')!.textContent === 'Built' && document.getElementById('start')!.hidden, null, { timeout: 120_000 });
const current = (p: Page) => p.evaluate(() => window.soma.project.current().catch(() => null)) as Promise<{ id: string; name: string } | null>;
const manifest = (folder: string) => JSON.parse(fs.readFileSync(path.join(home.root, folder, '.soma-mirror.json'), 'utf8')) as { id: string; files: Record<string, unknown> };

test('models\' home: New model asks for the name first, its folder is there at once; a name taken is offered with a number', async () => {
  const p = await openHome();
  // Canceled: nothing created, the start page stays
  await p.locator('#start-new:visible, #start-empty-new:visible').first().click();
  await dialog(p).getByRole('textbox', { name: 'Name' }).waitFor();
  await p.keyboard.press('Escape');
  await dialog(p).waitFor({ state: 'detached' });
  assert.equal(await current(p), null);
  assert.equal(await p.locator('#app-busy').isHidden(), true, 'no loading screen');
  assert.equal(await p.locator('#start').isVisible(), true);
  // A folder of the user's of that name: the next free name is offered
  fs.mkdirSync(path.join(home.root, 'Test'));
  fs.writeFileSync(path.join(home.root, 'Test', 'notes.txt'), 'the user');
  await p.locator('#start-new:visible, #start-empty-new:visible').first().click();
  const name = dialog(p).getByRole('textbox', { name: 'Name' });
  await name.fill('Test');
  await name.press('Enter');
  await dialog(p).getByText('There is a folder "Test" already').waitFor();
  assert.equal(await name.inputValue(), 'Test (2)');
  await name.fill('Bracket');
  await name.press('Enter');
  await until('model "Bracket"', async () => (await current(p))?.name === 'Bracket', 60_000);
  const m = (await current(p))!;
  await until('its folder', () => fs.existsSync(path.join(home.root, 'Bracket', '.soma-mirror.json')), 10_000);
  assert.equal(manifest('Bracket').id, m.id);
  assert.equal(fs.readFileSync(path.join(home.root, 'Test', 'notes.txt'), 'utf8'), 'the user');
  await built(p);
  await p.close();
});

test('models\' home: Ctrl+S saves into the model folder without a dialog, nothing in the root', async () => {
  const p = await openHome();
  await built(p);
  assert.equal((await current(p))?.name, 'Bracket');
  await p.locator('#viewer').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await p.keyboard.press('Control+s');
  const file = path.join(home.root, 'Bracket', 'Bracket.soma');
  await until('Bracket.soma in its folder', () => fs.existsSync(file), 60_000);
  assert.equal(await dialog(p).count(), 0, 'no dialog');
  assert.deepEqual(fs.readdirSync(home.root).filter((n) => !fs.statSync(path.join(home.root, n)).isDirectory()), [], 'no file in the root');
  // Noted as SOMA's, not copied onto itself
  await until('noted in the manifest', () => !!manifest('Bracket').files['Bracket.soma'], 10_000);
  const st = await p.evaluate(() => window.soma.project.saveState()) as { zipPath: string; unsaved: boolean };
  assert.equal(st.zipPath, file);
  assert.equal(st.unsaved, false);
  // Download is an action of its own
  const dl = p.waitForEvent('download');
  await p.evaluate(() => document.getElementById('btn-web-download')!.click());
  assert.equal((await dl).suggestedFilename(), 'Bracket.soma');
  await p.close();
});

test('models\' home: Save as under a new name moves the folder (all of it is SOMA\'s) and saves there', async () => {
  const p = await openHome();
  await built(p);
  const saving = p.evaluate(() => window.soma.project.save(true));
  const name = dialog(p).getByRole('textbox', { name: 'Model name' });
  await name.waitFor();
  assert.equal(await name.inputValue(), 'Bracket');
  await name.fill('Holder');
  await name.press('Enter');
  const r = await saving as { cancelled: boolean; error?: string; zipPath?: string };
  assert.equal(r.error, undefined);
  assert.equal(r.zipPath, path.join(home.root, 'Holder', 'Holder.soma'));
  assert.equal(fs.existsSync(path.join(home.root, 'Bracket')), false, 'moved, not copied');
  assert.deepEqual(fs.readdirSync(path.join(home.root, 'Holder')).filter((n) => n.endsWith('.soma')), ['Holder.soma']);
  assert.equal((await current(p))?.name, 'Holder');
  await p.close();
});

test('models\' home: Open starts in the synced folder, the folder browser makes new folders', async () => {
  const p = await openHome();
  await built(p);
  const opening = p.evaluate(() => window.soma.project.openZip());
  await p.locator('.web-where').getByText(home.root, { exact: true }).waitFor();
  await dialog(p).getByRole('button', { name: 'Holder' }).waitFor();
  await button(p, '.web-files', 'New folder').click();
  const name = p.locator('.web-files').last().getByRole('textbox', { name: 'Name' });
  await name.fill('Inbox');
  await name.press('Enter');
  await p.locator('.web-where').getByText(path.join(home.root, 'Inbox'), { exact: true }).waitFor();
  assert.equal(fs.statSync(path.join(home.root, 'Inbox')).isDirectory(), true);
  // Names that would lead out are refused
  await button(p, '.web-files', 'New folder').click();
  await name.fill('../out');
  await name.press('Enter');
  await p.locator('.web-files').last().getByText('cannot be a folder name').waitFor();
  await p.keyboard.press('Escape');
  await button(p, '.web-files', 'Cancel').click();
  assert.equal((await opening as { cancelled: boolean }).cancelled, true);
  assert.equal(fs.existsSync(path.join(home.root, 'out')), false);
  await p.close();
});
