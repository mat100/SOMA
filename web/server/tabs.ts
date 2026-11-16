import type { WebSocket } from 'ws';
import { decode, encode } from '../shared/codec';
import { PROTOCOL, validClientMessage, type ClientMessage, type Role, type ServerMessage } from '../shared/protocol';

/** Events kept for a page that lost its connection for a moment, at most this many bytes. More: the page has to reload. */
const MAX_WAITING = 32 * 1024 * 1024;
/** Sent but not yet taken by a slow tab, at most this many bytes. More: the connection is cut, the page reconnects. */
const MAX_UNSENT = 64 * 1024 * 1024;
/** A request to the browser (clipboard, link) that gets no answer fails after this time. */
const REQUEST_MS = 15_000;

export interface Conn {
  readonly role: Role;
  readonly page: string;
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface TabEvents {
  /** A message (invoke or send) from the tab that has the session, or from a render page. */
  message(conn: Conn, msg: Extract<ClientMessage, { t: 'invoke' | 'send' }>): void;
  /** A new page took the session (first connection, reload, another tab). */
  newPage(conn: Conn): void;
  /** The page with the session is back after losing its connection for a moment. */
  resumed(conn: Conn): void;
  /** A connection is gone (closed, lost). For the page with the session it may come back (resumed). */
  gone(conn: Conn): void;
}

/**
 * The browser tabs of the one user (one user per container). One page at a time has the session: the one that connected
 * last as a new page. It gets the events of the main process, as the window does on the desktop. While it is away for a
 * moment, events wait for it (up to MAX_WAITING). Render pages (role `render`, render.ts) are further connections of a tab.
 */
export class Tabs {
  private main: ConnImpl | null = null;
  private mainPage: string | null = null;
  private waiting: Uint8Array[] = [];
  private waitingBytes = 0;
  private overflow = false;
  private nextRequest = 1;
  private requests = new Map<number, { conn: ConnImpl; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly renders = new Set<Conn>();

  constructor(private readonly env: () => { testMode: boolean; startsHome: boolean }, private readonly events: TabEvents) {}

  /** Who has the session right now. */
  get active(): Conn | null { return this.main; }

  /** Event of the main process to the page with the session. */
  emit(ch: string, args: unknown[]): void {
    const frame = encode({ t: 'event', ch, args } satisfies ServerMessage);
    if (this.main) { this.main.raw(frame); return; }
    if (!this.mainPage || this.overflow) return;
    this.waitingBytes += frame.byteLength;
    if (this.waitingBytes > MAX_WAITING) { this.overflow = true; this.waiting = []; return; }
    this.waiting.push(frame);
  }

  /** Asks the page with the session to do something only a browser can do. Fails without a page or answer. */
  request(ch: string, args: unknown[]): Promise<void> {
    const conn = this.main;
    if (!conn) return Promise.reject(new Error('SOMA is not open in a browser tab.'));
    return new Promise((resolve, reject) => {
      const id = this.nextRequest++;
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('The browser did not answer.')); }, REQUEST_MS);
      this.requests.set(id, { conn, resolve, reject, timer });
      conn.send({ t: 'request', id, ch, args });
    });
  }

  accept(ws: WebSocket): void {
    let conn: ConnImpl | null = null;
    // The first message must be hello, within a few seconds
    const timer = setTimeout(() => ws.close(4000, 'No hello'), 10_000);
    ws.on('message', (data, isBinary) => {
      let msg: unknown;
      try {
        if (!isBinary) throw new Error('Text frames are not accepted.');
        msg = decode(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
      } catch (e) { ws.close(4002, e instanceof Error ? e.message.slice(0, 100) : 'Bad message'); return; }
      if (!validClientMessage(msg)) { ws.close(4002, 'Bad message'); return; }
      if (!conn) {
        clearTimeout(timer);
        if (msg.t !== 'hello') { ws.close(4001, 'Expected hello'); return; }
        if (msg.protocol !== PROTOCOL) {
          ws.send(encode({ t: 'refused', reason: 'The server was updated. Reload the page.' } satisfies ServerMessage));
          ws.close(4003, 'Protocol');
          return;
        }
        // Cut for being too slow: what it lost cannot be sent again, the page has to load anew
        conn = new ConnImpl(ws, msg.role, msg.page, () => { if (conn === this.main) this.overflow = true; });
        this.open(conn, msg.resume);
        return;
      }
      if (msg.t === 'hello') return;
      if (msg.t === 'reply') { this.reply(conn, msg); return; }
      // Only the page with the session acts. A page that was taken over has been told so and is closing.
      if (conn.role === 'main' && conn !== this.main) return;
      try { this.events.message(conn, msg); } catch (e) { console.error('[web] message', e); }
    });
    ws.on('close', () => { clearTimeout(timer); if (conn) this.closed(conn); });
    ws.on('error', () => { /* close follows */ });
  }

  private reply(conn: ConnImpl, msg: Extract<ClientMessage, { t: 'reply' }>): void {
    const r = this.requests.get(msg.id);
    if (!r || r.conn !== conn) return;
    this.requests.delete(msg.id);
    clearTimeout(r.timer);
    if (msg.ok) r.resolve(); else r.reject(new Error(msg.error ?? 'The browser refused.'));
  }

  private open(conn: ConnImpl, resume: boolean): void {
    if (conn.role === 'render') {
      this.renders.add(conn);
      conn.send({ t: 'welcome', env: this.env(), resumed: false });
      return;
    }
    const same = conn.page === this.mainPage;
    // A page that lost its connection and comes back after another page took over: it was taken, it takes nothing back
    if (resume && !same) { conn.send({ t: 'taken' }); conn.close(4004, 'Taken over'); return; }
    const resumed = same && resume && !this.overflow;
    const old = this.main;
    this.main = conn;
    if (old && old !== conn) { old.send({ t: 'taken' }); old.close(4004, 'Taken over'); }
    conn.send({ t: 'welcome', env: this.env(), resumed });
    if (resumed) {
      for (const f of this.waiting) conn.raw(f);
    } else {
      this.mainPage = conn.page;
      // Render pages belong to the tab that had the session
      for (const r of this.renders) r.close(4004, 'Taken over');
    }
    this.waiting = [];
    this.waitingBytes = 0;
    this.overflow = false;
    if (resumed) this.events.resumed(conn); else this.events.newPage(conn);
  }

  private closed(conn: ConnImpl): void {
    for (const [id, r] of this.requests) {
      if (r.conn !== conn) continue;
      clearTimeout(r.timer);
      r.reject(new Error('The browser tab is gone.'));
      this.requests.delete(id);
    }
    if (conn.role === 'render') { this.renders.delete(conn); this.events.gone(conn); return; }
    if (this.main !== conn) return;
    this.main = null;
    this.events.gone(conn);
  }
}

class ConnImpl implements Conn {
  constructor(private readonly ws: WebSocket, readonly role: Role, readonly page: string, private readonly cut: () => void) {}
  send(msg: ServerMessage): void { this.raw(encode(msg)); }
  raw(frame: Uint8Array): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    // A tab that does not keep up (stalled, very slow line) must not fill the server's memory: cut it, it reconnects
    if (this.ws.bufferedAmount > MAX_UNSENT) { this.cut(); this.ws.terminate(); return; }
    this.ws.send(frame);
  }
  close(code: number, reason: string): void { this.ws.close(code, reason); }
}
