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

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

before(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-web-test-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}/`;
  server = spawn(process.execPath, [path.join(WEB, 'bin', 'soma-web.cjs')], {
    env: { ...process.env, SOMA_WEB_PORT: String(port), SOMA_WEB_TOKEN: TOKEN, SOMA_USER_DATA: userData, SOMA_TEST: '1', SOMA_TEST_START: 'home' },
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
  assert.deepEqual(w.env, { testMode: true, startsHome: true });
  assert.equal(w.resumed, false);
  const settings = await a.invoke('settings:get') as { settings: unknown };
  assert.ok(settings.settings, 'settings of the app');
  assert.ok(Array.isArray(await a.invoke('project:list')));
  await assert.rejects(a.invoke('nope:nothing'), /Error invoking remote method 'nope:nothing'/);
  await assert.rejects(a.invoke('fs:list'), /No project open/);
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
