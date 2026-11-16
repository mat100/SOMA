/**
 * Messages on the WebSocket between a browser tab and the server (encoded with codec.ts). They carry the same channels as
 * Electron's IPC on the desktop (src/main/commands.ts, src/shared/api.ts).
 *
 * A tab says `hello` first. `page` is random per page load. After a short loss of the connection the same page connects
 * again with `resume` and gets what was sent meanwhile; if another page has the session by then, it gets `taken`. A new
 * page (first connection, reload, second tab) takes over the session; the tab that had it gets `taken`.
 */
export const PROTOCOL = 1;

export type Role = 'main' | 'render';

export type ClientMessage =
  | { t: 'hello'; protocol: number; role: Role; page: string; resume: boolean }
  | { t: 'invoke'; id: number; ch: string; args: unknown[] }
  | { t: 'send'; ch: string; args: unknown[] }
  /** Answer to a `request` of the server. */
  | { t: 'reply'; id: number; ok: boolean; value?: unknown; error?: string };

export type ServerMessage =
  | { t: 'welcome'; env: { testMode: boolean; startsHome: boolean }; resumed: boolean }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }
  | { t: 'event'; ch: string; args: unknown[] }
  /** Something only the browser can do (copy to the clipboard, open a link); the tab answers with `reply`. */
  | { t: 'request'; id: number; ch: string; args: unknown[] }
  /** Another tab took over the session, this one stops. */
  | { t: 'taken' }
  /** The server does not accept this tab (wrong protocol version). */
  | { t: 'refused'; reason: string };

/** Is this a message a tab may send? The server trusts nothing it did not check. */
export function validClientMessage(m: unknown): m is ClientMessage {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  const id = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
  const ch = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 100;
  switch (o.t) {
    case 'hello': return typeof o.protocol === 'number' && (o.role === 'main' || o.role === 'render') && typeof o.page === 'string'
      && o.page.length > 0 && o.page.length <= 100 && typeof o.resume === 'boolean';
    case 'invoke': return id(o.id) && ch(o.ch) && Array.isArray(o.args);
    case 'send': return ch(o.ch) && Array.isArray(o.args);
    case 'reply': return id(o.id) && typeof o.ok === 'boolean' && (o.error === undefined || typeof o.error === 'string');
    default: return false;
  }
}
