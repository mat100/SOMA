// The built server (npm run build) end to end over HTTP and the WebSocket, without a browser: login, the checks at the
// door, requests, and one tab at a time. Run with `npm test` (builds first) or `npm run test:server`.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { decode, encode } from '../shared/codec.ts';
import { PROTOCOL, type ServerMessage } from '../shared/protocol.ts';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token-123';
let server: ChildProcess;
let base: string;
let cookie: string;
let userData: string;
let filesRoot: string;

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

before(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-web-test-'));
  filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-web-files-'));
  fs.mkdirSync(path.join(filesRoot, 'models'));
  fs.writeFileSync(path.join(filesRoot, 'models', 'a.step'), 'x');
  fs.symlinkSync('/etc', path.join(filesRoot, 'models', 'out'));
  // A download from before a restart: the browser got it then, it is not offered again
  fs.mkdirSync(path.join(userData, 'downloads', 'before-restart'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'downloads', 'before-restart', 'Old.soma'), 'x');
  const port = await freePort();
  base = `http://127.0.0.1:${port}/`;
  server = spawn(process.execPath, [path.join(WEB, 'bin', 'soma-web.cjs')], {
    // Not in test mode: dialogs go to the page as for a user, not to prepared answers (dialogs.ts)
    env: { ...process.env, SOMA_TEST: undefined, SOMA_WEB_PORT: String(port), SOMA_WEB_TOKEN: TOKEN, SOMA_USER_DATA: userData, SOMA_WEB_FILES: filesRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${log}`)), 30_000);
    const on = (d: Buffer) => { log += d; if (log.includes('[web] SOMA')) { clearTimeout(timer); resolve(); } };
    server.stdout!.on('data', on);
    server.stderr!.on('data', on);
    server.once('exit', (code) => reject(new Error(`Server ended (${code}): ${log}`)));
  });
});

after(() => {
  server?.kill('SIGTERM');
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(filesRoot, { recursive: true, force: true });
});

/** A tab: the WebSocket after hello, with a queue of the messages from the server. */
async function tab(page: string, opts: { origin?: string; cookie?: string; resume?: boolean } = {}) {
  const ws = new WebSocket(new URL('ws', base).href.replace('http', 'ws'), {
    headers: { Origin: opts.origin ?? base.slice(0, -1), ...(opts.cookie ?? cookie ? { Cookie: opts.cookie ?? cookie } : {}) },
  });
  const inbox: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => { inbox.push(decode(d as Buffer) as ServerMessage); waiters.splice(0).forEach((w) => w()); });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  ws.send(encode({ t: 'hello', protocol: PROTOCOL, role: 'main', page, resume: opts.resume ?? false }));
  const next = async (pred: (m: ServerMessage) => boolean, ms = 15_000): Promise<ServerMessage> => {
    const t0 = Date.now();
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() - t0 > ms) throw new Error('Timeout waiting for a message');
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 200); });
    }
  };
  let id = 0;
  const invoke = async (ch: string, ...args: unknown[]) => {
    const my = ++id;
    ws.send(encode({ t: 'invoke', id: my, ch, args }));
    const r = await next((m) => m.t === 'result' && m.id === my) as Extract<ServerMessage, { t: 'result' }>;
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  return { ws, next, invoke, closed };
}

test('without the token no page; the token gives a cookie and a redirect without it', async () => {
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(`${base}?token=wrong`, { redirect: 'manual' })).status, 403);
  const r = await fetch(`${base}?token=${TOKEN}`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), './');
  const set = r.headers.get('set-cookie') ?? '';
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.ok(!set.includes(TOKEN), 'the token itself is not the cookie');
  cookie = set.split(';')[0];
  const page = await fetch(base, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script src="main.js">/);
});

test('static files stay inside their folder', async () => {
  const r = await fetch(`${base}..%2f..%2fpackage.json`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 404);
});

test('WebSocket: refused without cookie or from another origin', async () => {
  await assert.rejects(tab('p0', { cookie: 'soma_session=nope' }), /403/);
  await assert.rejects(tab('p0', { origin: 'http://evil.example' }), /403/);
});

test('requests reach the main process, errors come back as with Electron', async () => {
  const a = await tab('page-a');
  const w = await a.next((m) => m.t === 'welcome') as Extract<ServerMessage, { t: 'welcome' }>;
  assert.deepEqual(w.env, { testMode: false, startsHome: true });
  assert.equal(w.resumed, false);
  const settings = await a.invoke('settings:get') as { settings: unknown };
  assert.ok(settings.settings, 'settings of the app');
  assert.ok(Array.isArray(await a.invoke('project:list')));
  await assert.rejects(a.invoke('nope:nothing'), /Error invoking remote method 'nope:nothing'/);
  await assert.rejects(a.invoke('fs:list'), /No project open/);
  await assert.rejects(a.next((m) => m.t === 'request' && m.ch === 'web:download', 1500), /Timeout/, 'what was staged before the start is not downloaded again');
  a.ws.close();
  await a.closed;
});

test('one tab at a time: a new page takes over, the same page reconnects', async () => {
  const a = await tab('page-1');
  await a.next((m) => m.t === 'welcome');
  const b = await tab('page-2');
  await b.next((m) => m.t === 'welcome');
  await a.next((m) => m.t === 'taken');
  assert.equal(await a.closed, 4004);
  // page-2 loses its connection for a moment and comes back: no new page, nothing taken
  b.ws.terminate();
  await b.closed;
  const b2 = await tab('page-2', { resume: true });
  const w = await b2.next((m) => m.t === 'welcome') as Extract<ServerMessage, { t: 'welcome' }>;
  assert.equal(w.resumed, true);
  assert.ok(await b2.invoke('settings:get'));
  // page-1 lost its connection before it heard that it was taken over: coming back, it takes nothing back
  const a2 = await tab('page-1', { resume: true });
  await a2.next((m) => m.t === 'taken');
  assert.equal(await a2.closed, 4004);
  assert.ok(await b2.invoke('settings:get'), 'page-2 keeps the session');
  b2.ws.close();
});

test('a message of the wrong shape closes the connection, the server lives on', async () => {
  const a = await tab('page-shape');
  await a.next((m) => m.t === 'welcome');
  a.ws.send(encode({ t: 'send', ch: 'dialog:res', args: null }));
  assert.equal(await a.closed, 4002);
  const b = await tab('page-after');
  await b.next((m) => m.t === 'welcome');
  assert.ok(await b.invoke('settings:get'));
  b.ws.close();
});

test('a request target that is no URL is refused, the server lives on', async () => {
  const status = await new Promise<string>((resolve, reject) => {
    const s = net.connect(Number(new URL(base).port), '127.0.0.1', () => s.write('GET //[/ HTTP/1.1\r\nHost: x\r\n\r\n'));
    s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); s.destroy(); });
    s.once('error', reject);
  });
  assert.match(status, /^HTTP\/1\.1 400/);
  assert.equal((await fetch(base, { headers: { Cookie: cookie } })).status, 200);
});

test('a message that is no hello first closes the connection', async () => {
  const ws = new WebSocket(new URL('ws', base).href.replace('http', 'ws'), { headers: { Origin: base.slice(0, -1), Cookie: cookie } });
  await new Promise((r) => ws.once('open', r));
  ws.send(encode({ t: 'invoke', id: 1, ch: 'settings:get', args: [] }));
  const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
  assert.equal(code, 4001);
});

test('terminals stay on the server: a new page lists them with their output', async () => {
  const a = await tab('page-term-1');
  await a.next((m) => m.t === 'welcome');
  await a.invoke('project:create');
  const id = await a.invoke('term:create', { title: 'Shell' }) as number;
  a.ws.send(encode({ t: 'send', ch: 'term:write', args: [id, 'echo TAIL-$((6*7))\r'] }));
  await a.next((m) => m.t === 'event' && m.ch === 'term:data' && String(m.args[1]).includes('TAIL-42'));
  // Reload: a new page, the shell is still there with what it printed
  const b = await tab('page-term-2');
  await b.next((m) => m.t === 'welcome');
  const list = await b.invoke('term:list') as { id: number; title: string; agent: boolean; output: string }[];
  const t = list.find((x) => x.id === id);
  assert.ok(t, 'the terminal is listed');
  assert.equal(t.title, 'Shell');
  assert.equal(t.agent, false);
  assert.match(t.output, /TAIL-42/);
  b.ws.send(encode({ t: 'send', ch: 'term:kill', args: [id] }));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!(await b.invoke('term:list') as { id: number }[]).some((x) => x.id === id), 'closed terminals are gone');
  b.ws.close();
});

test('upload: only from the page itself, the file lands in a batch folder of the app data', async () => {
  const batch = 'ab'.repeat(12);
  const up = (headers: Record<string, string>) => fetch(`${base}upload?batch=${batch}&name=${encodeURIComponent('../part one.step')}`, { method: 'POST', body: 'STEP DATA', headers });
  assert.equal((await up({ Cookie: cookie })).status, 403, 'without Origin');
  assert.equal((await up({ Cookie: cookie, Origin: 'http://evil.example' })).status, 403);
  assert.equal((await up({ Origin: base.slice(0, -1) })).status, 401, 'without cookie');
  const r = await up({ Cookie: cookie, Origin: base.slice(0, -1) });
  assert.equal(r.status, 200);
  const { path: p } = await r.json() as { path: string };
  assert.equal(path.dirname(p), path.join(userData, 'uploads', batch), 'no way out of the batch folder');
  assert.equal(path.basename(p), 'part one.step');
  assert.equal(fs.readFileSync(p, 'utf8'), 'STEP DATA');
  const again = await (await up({ Cookie: cookie, Origin: base.slice(0, -1) })).json() as { path: string };
  assert.equal(path.basename(again.path), 'part one (2).step', 'the same name twice: nothing overwritten');
  assert.equal((await fetch(`${base}upload?batch=../x&name=a`, { method: 'POST', body: 'x', headers: { Cookie: cookie, Origin: base.slice(0, -1) } })).status, 400);
});

test('downloads need a token the server handed out', async () => {
  assert.equal((await fetch(`${base}download/aaaaaaaaaaaaaaaa`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(`${base}download/aaaaaaaaaaaaaaaa`)).status, 401);
});

test('the file dialogs see the server only below their folder', async () => {
  const a = await tab('page-files');
  await a.next((m) => m.t === 'welcome');
  const root = await a.invoke('web:listDir') as { dir: string; parent: string | null; entries: { name: string; dir: boolean }[] };
  assert.equal(root.dir, filesRoot);
  assert.equal(root.parent, null);
  assert.deepEqual(root.entries, [{ name: 'models', dir: true }]);
  const sub = await a.invoke('web:listDir', path.join(filesRoot, 'models')) as { entries: { name: string }[]; parent: string };
  assert.deepEqual(sub.entries.map((e) => e.name), ['a.step'], 'links are not listed');
  assert.equal(sub.parent, filesRoot);
  const outside = await a.invoke('web:listDir', '/etc') as { dir: string };
  assert.equal(outside.dir, filesRoot, 'outside the folder: back at its top');
  const viaLink = await a.invoke('web:listDir', path.join(filesRoot, 'models', 'out')) as { dir: string };
  assert.equal(viaLink.dir, filesRoot, 'a link that points out leads nowhere');
  a.ws.close();
});

test('save with "Download": the model comes to the browser, saving again downloads it again', async () => {
  const a = await tab('page-save');
  await a.next((m) => m.t === 'welcome');
  await a.invoke('project:create');
  const saving = a.invoke('project:save', true);
  const ask = await a.next((m) => m.t === 'request' && m.ch === 'web:saveDialog') as Extract<ServerMessage, { t: 'request' }>;
  assert.match((ask.args[0] as { name: string }).name, /\.soma$/);
  a.ws.send(encode({ t: 'reply', id: ask.id, ok: true, value: { kind: 'download', name: 'Box.soma' } }));
  const dl = await a.next((m) => m.t === 'request' && m.ch === 'web:download') as Extract<ServerMessage, { t: 'request' }>;
  a.ws.send(encode({ t: 'reply', id: dl.id, ok: true }));
  const saved = await saving as { cancelled: boolean; error?: string; zipPath?: string };
  assert.equal(saved.cancelled, false);
  assert.equal(saved.error, undefined);
  assert.equal(saved.zipPath, 'Box.soma', 'the page names the downloaded file, not a folder of the server');
  assert.equal(dl.args[1], 'Box.soma');
  const file = await fetch(new URL(String(dl.args[0]), base), { headers: { Cookie: cookie } });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition') ?? '', /attachment/);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 2)], [0x50, 0x4b], 'a ZIP (.soma)');
  // Ctrl+S once more: the same file, downloaded again (no dialog)
  const again = a.invoke('project:save', false);
  const dl2 = await a.next((m) => m.t === 'request' && m.ch === 'web:download') as Extract<ServerMessage, { t: 'request' }>;
  a.ws.send(encode({ t: 'reply', id: dl2.id, ok: true }));
  assert.equal((await again as { error?: string }).error, undefined);
  assert.equal(dl2.args[1], 'Box.soma');
  a.ws.close();
});

test('ChatGPT sign-in: the address the page ended at reaches pi (the callback cannot, on a server)', async () => {
  const a = await tab('page-signin');
  await a.next((m) => m.t === 'welcome');
  const none = await a.invoke('ai:signInCode', 'http://127.0.0.1:1455/auth/callback?code=x&state=y') as { ok: boolean; error?: string };
  assert.equal(none.ok, false, 'no sign-in running');
  const signing = a.invoke('ai:signIn') as Promise<{ ok: boolean; error?: string; cancelled?: boolean }>;
  const url = await a.next((m) => m.t === 'event' && m.ch === 'ai:signInUrl', 30_000) as Extract<ServerMessage, { t: 'event' }>;
  assert.match(String(url.args[0]), /^https:\/\/auth\.openai\.com\//);
  const bad = await a.invoke('ai:signInCode', 'https://example.com/') as { ok: boolean; error?: string };
  assert.equal(bad.ok, false, 'only the callback address');
  // A real code cannot exist in a test: pi takes the address and refuses its state, which proves it got there
  const sent = await a.invoke('ai:signInCode', 'http://127.0.0.1:1455/auth/callback?code=abc&state=not-the-right-one&client_id=x') as { ok: boolean };
  assert.equal(sent.ok, true);
  const r = await signing;
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /state/i);
  a.ws.close();
});
