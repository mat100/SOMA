import type { ApiEnv, Transport } from '../../app/src/shared/api';

/** What the server says about the session (the platform the page knows itself). */
export type ServerEnv = Omit<ApiEnv, 'platform'>;
import { decode, encode } from '../shared/codec';
import { uploadDropped } from './files';
import { PROTOCOL, type ClientMessage, type Role, type ServerMessage } from '../shared/protocol';

export interface TransportEvents {
  /** The connection is lost; it is tried again. */
  offline(): void;
  /** Connected again (the same page, nothing was lost). */
  online(): void;
  /** Another tab or a reload took over the session, or the server refuses this page: it stops. */
  stopped(reason: 'taken' | 'refused', message?: string): void;
}

/**
 * The desktop's IPC (preload.ts) on a WebSocket to the server (web/server). Requests that are open while the connection
 * is lost fail: the server may or may not have done them, repeating could do them twice (saving, creating a model).
 */
export class WsTransport implements Transport {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  private requestHandlers = new Map<string, (...args: unknown[]) => unknown>();
  private readonly page: string;
  private opened = false;
  private stopped = false;
  private retry = 0;
  private welcomed: ((env: ServerEnv) => void) | null = null;

  /** `page`: the name the server gave this page (a render frame); a main page makes up its own. */
  constructor(private readonly role: Role, private readonly events: TransportEvents, page?: string) {
    // getRandomValues, not randomUUID: that one exists only on https and localhost, the page may come over plain http
    this.page = page || [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Connects and waits for the welcome of the server. */
  connect(): Promise<ServerEnv> {
    return new Promise((resolve) => { this.welcomed = resolve; this.open(); });
  }

  invoke(ch: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error(`Error invoking remote method '${ch}': no connection to the SOMA server`)); return; }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      ws.send(encode({ t: 'invoke', id, ch, args } satisfies ClientMessage));
    });
  }

  send(ch: string, ...args: unknown[]): void {
    // Without a connection lost, as a message to a window that is gone
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode({ t: 'send', ch, args } satisfies ClientMessage));
  }

  on(ch: string, cb: (...args: unknown[]) => void): void {
    const l = this.listeners.get(ch) ?? [];
    l.push(cb);
    this.listeners.set(ch, l);
  }

  /** Does what the server asks of the browser (`request`); the result or a thrown error goes back as the answer. */
  onRequest(ch: string, fn: (...args: unknown[]) => unknown): void { this.requestHandlers.set(ch, fn); }

  /** Dropped files are uploaded first, the main process takes them from the server (files.ts). */
  filePaths(files: File[]): Promise<string[]> { return uploadDropped(files); }

  private open(): void {
    const url = new URL('ws', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '';
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const resume = this.opened;
    ws.onopen = () => { this.opened = true; ws.send(encode({ t: 'hello', protocol: PROTOCOL, role: this.role, page: this.page, resume } satisfies ClientMessage)); };
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try { msg = decode(e.data as ArrayBuffer) as ServerMessage; } catch (err) { console.error('[soma] bad message from the server', err); return; }
      this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [, p] of this.pending) p.reject(new Error('The connection to the SOMA server was lost.'));
      this.pending.clear();
      if (this.stopped) return;
      // A render page does not come back: the server has given up its jobs already, it opens a new one when needed
      if (this.role === 'render') { this.stopped = true; return; }
      this.events.offline();
      // Again soon, then less often
      const delay = Math.min(5000, 250 * 2 ** this.retry++);
      setTimeout(() => { if (!this.stopped) this.open(); }, delay);
    };
  }

  private receive(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.retry = 0;
        if (this.welcomed) { this.welcomed(msg.env); this.welcomed = null; }
        else if (msg.resumed) this.events.online();
        // The server no longer knows this page (it restarted, too much was lost): only a reload shows the right state
        else { this.stop(); location.reload(); }
        return;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value); else p.reject(new Error(msg.error));
        return;
      }
      case 'event':
        for (const cb of this.listeners.get(msg.ch) ?? []) {
          try { cb(...msg.args); } catch (e) { console.error(`[soma] listener of ${msg.ch}`, e); }
        }
        return;
      case 'request': void this.answer(msg.id, msg.ch, msg.args); return;
      case 'taken': this.stop(); this.events.stopped('taken'); return;
      case 'refused': this.stop(); this.events.stopped('refused', msg.reason); return;
    }
  }

  private async answer(id: number, ch: string, args: unknown[]): Promise<void> {
    let reply: ClientMessage;
    try {
      const fn = this.requestHandlers.get(ch);
      if (!fn) throw new Error(`The page cannot do ${ch}.`);
      reply = { t: 'reply', id, ok: true, value: await fn(...args) };
    } catch (e) { reply = { t: 'reply', id, ok: false, error: e instanceof Error ? e.message : String(e) }; }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(reply));
  }

  private stop(): void {
    this.stopped = true;
    this.ws?.close();
  }
}
