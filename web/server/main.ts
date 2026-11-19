import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { osName } from '../../app/src/main/about';
import { logFailures, registerCommands, type Handler } from '../../app/src/main/commands';
import { startCore, stopCore } from '../../app/src/main/core';
import { setDialogHost, type ChooseOptions } from '../../app/src/main/dialogs';
import { initLog } from '../../app/src/main/log';
import { logsDir, pythonExe, userDataDir } from '../../app/src/main/paths';
import { setPlatform } from '../../app/src/main/platform';
import { ProjectController } from '../../app/src/main/projects';
import { createProject, getLastProject } from '../../app/src/main/workspace';
import { SOMA_VERSION } from '../../app/src/shared/version';
import { Files, listDir } from './files';
import { Mirror, type MirrorModel, type MirrorSave } from './mirror';
import { authorized, handleLogin, sameOrigin, serveStatic, type AuthMode } from './http';
import { webPlatform } from './platform';
import { RenderFrames } from './render';
import { Tabs, type Conn } from './tabs';

/*
 * SOMA in the browser: this server is what the main process of the desktop app is (src/main, unchanged), the browser tab
 * is the window. One user per server (one container per user): the server is the user's own machine, as the desktop app
 * is. Configuration through the environment, see web/README.md.
 */

const WEB_DIR = path.resolve(__dirname, '..');
const APP_DIR = path.resolve(WEB_DIR, '..', 'app');
const PUBLIC_DIR = path.join(WEB_DIR, 'dist', 'public');

const env = process.env;
const host = env.SOMA_WEB_HOST || '127.0.0.1';
const port = Number(env.SOMA_WEB_PORT) || 5173;
const userData = env.SOMA_USER_DATA || path.join(os.homedir(), '.soma-web');
const testMode = env.SOMA_TEST === '1';
/** The folder on the server the file dialogs show (open, save, open folder). */
const filesRoot = path.resolve(env.SOMA_WEB_FILES || os.homedir());
/**
 * Prefix under which a proxy forwards requests without removing it (Coder's path-based apps: `/@user/ws.agent/apps/web/`).
 * The pages use relative addresses only, so they need nothing else to know about it.
 */
const basePath = (env.SOMA_WEB_BASE ?? '/').replace(/\/*$/, '/');
const stripBase = (pathname: string) => (basePath !== '/' && pathname.startsWith(basePath) ? pathname.slice(basePath.length - 1) : pathname);
/** Further origins allowed for the WebSocket (comma separated), for proxies that change the host. */
const origins = (env.SOMA_WEB_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/** The synced folder (mirror.ts): results of the open model as files for a sync tool. Off without the variable. */
const mirrorDir = env.SOMA_MIRROR_DIR?.trim() ? path.resolve(env.SOMA_MIRROR_DIR.trim()) : null;

function authMode(): AuthMode {
  if (env.SOMA_WEB_AUTH === 'proxy') {
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.error('[web] SOMA_WEB_AUTH=proxy needs SOMA_WEB_HOST on localhost: the proxy in front is the only way in.');
      process.exit(2);
    }
    // Only the proxy's own address may open the WebSocket: a page under another name (DNS rebinding) must not
    if (!origins.length) {
      console.error('[web] SOMA_WEB_AUTH=proxy needs SOMA_WEB_ORIGINS, the address of the proxy (https://…).');
      process.exit(2);
    }
    return { kind: 'proxy' };
  }
  if (env.SOMA_WEB_TOKEN !== undefined) {
    if (env.SOMA_WEB_TOKEN.trim().length < 8) { console.error('[web] SOMA_WEB_TOKEN is too short (at least 8 characters).'); process.exit(2); }
    return { kind: 'token', token: env.SOMA_WEB_TOKEN.trim() };
  }
  // Without a given token: one of its own, kept in the app data so links stay valid after a restart
  const file = path.join(userData, 'web-token');
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token.length >= 16) return { kind: 'token', token };
    console.error(`[web] ${file} holds no usable token, making a new one.`);
  } catch { /* new one */ }
  const token = randomBytes(24).toString('base64url');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return { kind: 'token', token };
}

fs.mkdirSync(userData, { recursive: true });
const auth = authMode();

let ctl: ProjectController | null = null;
const handlers = new Map<string, Handler>();
const listeners = new Map<string, Handler>();

/** Requests of the page that are still running (files.deliverChanged waits for none). */
let running = 0;
/** Has the session been opened with a model yet (test mode opens one at the first page, as the desktop at its window)? */
let testOpened = false;

const tabs = new Tabs(() => ({ testMode, startsHome: !testMode ? !ctl?.session : env.SOMA_TEST_START === 'home' && !ctl?.session }), {
  message(conn, msg) {
    if (msg.t === 'send') {
      if (conn.role === 'render') { renderEvents(conn, msg.ch, msg.args); return; }
      if (msg.ch === 'dialog:ready') { pageReady(conn); return; }
      if (msg.ch === 'dialog:res') { dialogAnswer(msg.args[0], msg.args[1]); return; }
      const fn = listeners.get(msg.ch);
      if (fn) try { fn(...msg.args); } catch (e) { console.error(`[${msg.ch}]`, e); }
      return;
    }
    const fn = conn.role === 'main' ? handlers.get(msg.ch) : undefined;
    if (!fn) { conn.send({ t: 'result', id: msg.id, ok: false, error: `Error invoking remote method '${msg.ch}': unknown request` }); return; }
    void (async () => {
      try {
        running++;
        try { conn.send({ t: 'result', id: msg.id, ok: true, value: files.forPage(await fn(...msg.args)) }); } finally { running--; }
        // What requests wrote into the download area (an export, a saved model) goes to the browser, once none of them
        // is still writing
        if (!running) await files.deliverChanged();
      } catch (e) {
        // As Electron logs exceptions of handlers and passes them to the renderer
        console.error(`Error occurred in handler for '${msg.ch}':`, e);
        conn.send({ t: 'result', id: msg.id, ok: false, error: `Error invoking remote method '${msg.ch}': ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}` });
      }
    })();
  },
  newPage() { dropDialogs(); dialogPage = null; },
  resumed(conn) { if (conn.page === dialogPage) hostDialogs(conn); },
  gone(conn) { if (conn.role === 'main') dropDialogs(); else renderGone(conn); },
});

const files = new Files(userData, (url, name) => tabs.request('web:download', [url, name]));
const renderFrames = new RenderFrames(tabs);
const platformHost = webPlatform({ appDir: APP_DIR, userData, filesRoot }, tabs, files, renderFrames);
setPlatform(mirrorDir ? withMirror(platformHost, mirrorDir) : platformHost);
// As Electron's main process: an error nobody caught is in the log (log.ts writes it), the server keeps running
process.on('uncaughtException', () => {});
// The main process reads SOMA_USER_DATA (paths.ts); the same folder for everything, terminals included
process.env.SOMA_USER_DATA = userData;

initLog(logsDir(), {
  version: SOMA_VERSION, system: `${osName()} ${process.arch}`, web: `Node.js ${process.versions.node}`,
  python: pythonExe(), appData: userDataDir(),
});

// ---- Synced folder (mirror.ts) --------------------------------------------------------------------------------------------

/**
 * Follows what the main process tells the page: a finished build, new drawings, changed files (renders), a save. Each of
 * them brings the folder of the open model up to date, a moment later so a burst of messages makes one sync.
 */
function withMirror(host: ReturnType<typeof webPlatform>, root: string): ReturnType<typeof webPlatform> {
  const mirror = new Mirror(root, {
    versions: env.SOMA_MIRROR_VERSIONS !== '0',
    onStatus: (s) => tabs.emit('web:mirror', [s]),
  });
  handlers.set('web:mirrorStatus', () => mirror.status());
  /** The open model as the page was told last (project:changed), and what waits to be synced for it. */
  let model: MirrorModel | null = null;
  let save: MirrorSave | undefined;
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (model) {
      // The name as it is now: saving under a new file name renames the model without telling the page
      try { if (ctl?.session?.id === model.id) model = { ...model, name: ctl.info().name }; } catch { /* the last one known */ }
      void mirror.sync(model, save);
    }
    save = undefined;
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 1000);
  };
  console.log(`[web] synced folder: ${root}`);
  return {
    ...host,
    send(channel, ...args) {
      host.send(channel, ...args);
      const a = args[0] as Record<string, unknown> | undefined;
      if (channel === 'project:changed') {
        const next = a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.dir === 'string' ? { id: a.id, name: a.name, dir: a.dir } : null;
        // Another model: what waits for the previous one (a save just before) is synced for it now
        if (model && next?.id !== model.id && timer) flush();
        model = next;
        schedule();
      } else if (channel === 'build:status') {
        if (a?.state === 'ok') schedule();
      } else if (channel === 'save:state') {
        save = { head: typeof a?.savedHead === 'string' ? a.savedHead : null, zipPath: typeof a?.zipPath === 'string' ? a.zipPath : null };
        schedule();
      } else if (channel === 'drawings:changed' || channel === 'fs:changed') {
        schedule();
      }
    },
  };
}

// ---- Questions in the page (dialogs.ts), as hostDialogs in main.ts of the desktop ---------------------------------------

let nextDialog = 0;
const pendingDialogs = new Map<number, (i: number | null) => void>();
/** The page that shows questions (it said dialog:ready). After a short loss of the connection it shows them again. */
let dialogPage: string | null = null;
function dropDialogs(): void {
  setDialogHost(null);
  for (const r of pendingDialogs.values()) r(null);
  pendingDialogs.clear();
}
function dialogAnswer(id: unknown, i: unknown): void {
  const r = pendingDialogs.get(Number(id));
  if (!r) return;
  pendingDialogs.delete(Number(id));
  r(typeof i === 'number' ? i : null);
}

/** Questions (dialogs.ts choose) go to this page while it has the session. */
function hostDialogs(conn: Conn): void {
  setDialogHost((o: ChooseOptions) => new Promise((resolve) => {
    if (conn !== tabs.active) { resolve(null); return; }
    const id = ++nextDialog;
    pendingDialogs.set(id, resolve);
    tabs.emit('dialog:show', [id, o]);
  }));
}

/** The page has loaded and listens (it says so with dialog:ready, see src/shared/api.ts). */
function pageReady(conn: Conn): void {
  if (conn !== tabs.active) return;
  dialogPage = conn.page;
  hostDialogs(conn);
  const c = ctl;
  if (!c) return;
  if (c.session) {
    // A reload or another tab: the model stays open on the server, the page shows it again
    tabs.emit('project:changed', [c.info()]);
    tabs.emit('build:status', [c.session.builds.status]);
    return;
  }
  // Tests open the last model straight away, as the desktop app does with its window (main.ts)
  if (testMode && env.SOMA_TEST_START !== 'home' && !testOpened) {
    testOpened = true;
    void (async () => {
      try { await c.open(getLastProject() ?? (await createProject()).id); }
      catch (e) { console.error('[soma] Could not open the project:', e); }
    })();
  }
}

// ---- Render pages (render.ts) -----------------------------------------------------------------------------------------------

function renderEvents(conn: Conn, ch: string, args: unknown[]): void { renderFrames.message(conn, ch, args); }
function renderGone(conn: Conn): void { renderFrames.gone(conn); }

// ---- Commands ------------------------------------------------------------------------------------------------------------

function registerAll(c: ProjectController): void {
  registerCommands(c, (ch, fn) => handlers.set(ch, logFailures(ch, fn)), (ch, fn) => listeners.set(ch, fn));
  // No software rendering to switch to: the browser decides about WebGL
  handlers.set('gpu:webglFailed', () => false);
  // Tests: like closing the window of the desktop app, which quits it (the open model is left, E69)
  if (testMode) handlers.set('test:close', () => { void shutdown(); });
  // The file dialogs of the page (web/client/files.ts) browse the server below filesRoot
  handlers.set('web:listDir', (dir: unknown) => listDir(filesRoot, dir));
}

// ---- HTTP and WebSocket ----------------------------------------------------------------------------------------------------

/** The path of a request, null when it cannot be read (then the request is refused, nothing throws). */
function requestUrl(req: http.IncomingMessage): URL | null {
  try { return new URL(req.url ?? '/', 'http://localhost'); } catch { return null; }
}

const server = http.createServer((req, res) => {
  const url = requestUrl(req);
  if (!url) { res.writeHead(400).end(); return; }
  if (handleLogin(req, res, url, auth)) return;
  if (!authorized(req, auth)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('SOMA: open the link with the token that the server printed when it started (…/?token=…).');
    return;
  }
  const route = stripBase(url.pathname);
  if (req.method === 'POST' && route === '/upload') {
    // Writes on the server: only from the page itself (the cookie is SameSite=Strict as well)
    if (!sameOrigin(req, origins, auth.kind === 'proxy')) { res.writeHead(403).end(); return; }
    void files.receiveUpload(req, res, url);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  const dl = /^\/download\/([A-Za-z0-9_-]{10,64})$/.exec(route);
  if (dl) { void files.serveDownload(res, dl[1]); return; }
  serveStatic(res, PUBLIC_DIR, route, req.method === 'HEAD');
});

// A finished video comes back from the render page in one message, as over IPC on the desktop: up to 1 GB
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = requestUrl(req);
  // A page of this server from an origin it does not know (a proxy that changes the host): say what to set
  if (url && stripBase(url.pathname) === '/ws' && authorized(req, auth) && !sameOrigin(req, origins, auth.kind === 'proxy')) {
    console.warn(`[web] WebSocket refused: origin ${String(req.headers.origin)}, host ${String(req.headers.host)}, forwarded host ${String(req.headers['x-forwarded-host'] ?? '-')}. Behind a proxy: SOMA_WEB_ORIGINS=${String(req.headers.origin)}`);
  }
  if (!url || stripBase(url.pathname) !== '/ws' || !authorized(req, auth) || !sameOrigin(req, origins, auth.kind === 'proxy')) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => tabs.accept(ws));
});

void (async () => {
  await startCore(() => ctl);
  ctl = new ProjectController();
  registerAll(ctl);
  server.listen(port, host, () => {
    const where = `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
    console.log(`[web] SOMA ${SOMA_VERSION} on ${where}${auth.kind === 'token' ? `?token=${auth.token}` : ' (authentication by the proxy)'}`);
  });
})();

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log('[soma] quit');
  server.close();
  for (const ws of wss.clients) ws.close(1001, 'Server stops');
  try { await ctl?.leave(); } catch { /* ends anyway */ }
  ctl?.close();
  ctl?.renders.close();
  stopCore();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
