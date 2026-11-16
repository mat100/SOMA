import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

/**
 * Who may use the server. The server runs code and shells for its user, so every request needs proof:
 * - `token`: the start URL carries `?token=…` once. The server answers with a cookie (HttpOnly, SameSite=Strict) and
 *   sends the browser on to the URL without the token, so it stays out of the history. The cookie is derived from the
 *   token (HMAC): a restart of the server keeps it valid, the token itself is never stored in the browser.
 * - `proxy`: a proxy in front authenticates (Coder, an SSO gateway). Only with the server listening on localhost.
 */
export type AuthMode = { kind: 'token'; token: string } | { kind: 'proxy' };

const COOKIE = 'soma_session';

const cookieValue = (token: string) => createHmac('sha256', token).update('soma-web-session').digest('base64url');

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookies(req: IncomingMessage): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return m;
}

export function authorized(req: IncomingMessage, auth: AuthMode): boolean {
  if (auth.kind === 'proxy') return true;
  const c = cookies(req).get(COOKIE);
  return !!c && same(c, cookieValue(auth.token));
}

/**
 * The page and the WebSocket must come from the same site: a page elsewhere must not drive this server with the user's
 * cookie. Browsers always send Origin with a WebSocket. Behind a proxy the host the browser sees is in X-Forwarded-Host.
 */
export function sameOrigin(req: IncomingMessage, allowed: string[], onlyAllowed = false): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  if (allowed.includes(origin)) return true;
  // Behind an authenticating proxy (SOMA_WEB_AUTH=proxy) the headers say nothing reliable, only the given origins count
  if (onlyAllowed) return false;
  const fwd = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  return host === req.headers.host || (!!fwd && host === fwd);
}

/**
 * Answers the login with the token. true: answered (redirect or refusal), the caller is done.
 */
export function handleLogin(req: IncomingMessage, res: ServerResponse, url: URL, auth: AuthMode): boolean {
  if (auth.kind !== 'token' || !url.searchParams.has('token')) return false;
  if (!same(url.searchParams.get('token') ?? '', auth.token)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Wrong token.');
    return true;
  }
  const secure = req.headers['x-forwarded-proto'] === 'https' || (req.socket as { encrypted?: boolean }).encrypted;
  url.searchParams.delete('token');
  // Relative: a proxy may put the app below a prefix the server does not see
  const last = url.pathname.split('/').pop() ?? '';
  res.writeHead(303, {
    'Set-Cookie': `${COOKIE}=${cookieValue(auth.token)}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`,
    Location: `${last || './'}${url.search}`,
    'Cache-Control': 'no-store',
  }).end();
  return true;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

/** Files of the user interface (built into `root`). Only GET and HEAD, nothing outside the folder. */
export function serveStatic(res: ServerResponse, root: string, rel: string, head: boolean): void {
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { res.writeHead(400).end(); return; }
  const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found.'); return; }
  if (st.isDirectory()) { serveStatic(res, root, path.posix.join(decoded, 'index.html'), head); return; }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': st.size,
    // Development and updates: always ask, the files are small and local
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (head) { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}
