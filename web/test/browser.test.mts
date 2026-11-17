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
let browser: Browser;
let context: BrowserContext;

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 30_000) => {
  for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 200))) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${what}`);
  }
};

before(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-web-browser-'));
  filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-web-browser-files-'));
  fs.mkdirSync(path.join(filesRoot, 'models'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}/`;
  server = spawn(process.execPath, [path.join(WEB, 'bin', 'soma-web.cjs')], {
    env: { ...process.env, SOMA_TEST: undefined, SOMA_WEB_PORT: String(port), SOMA_WEB_TOKEN: TOKEN, SOMA_USER_DATA: userData, SOMA_WEB_FILES: filesRoot },
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
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(filesRoot, { recursive: true, force: true });
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
