import { randomBytes } from 'node:crypto';
import type { RenderWindow, RenderWindowEvents } from '../../app/src/main/platform';
import type { RenderJob } from '../../app/src/shared/types';
import type { Conn, Tabs } from './tabs';

/**
 * The invisible render window of the desktop (render.ts in app/src/main, E58) as a hidden frame in the user's tab: it
 * renders with the GPU of the user's computer. The frame loads render.html with a name of its own and connects with the
 * role `render` (web/client/render.ts). Without a tab there is nothing to render with; the job fails and says so.
 */
export class RenderFrames {
  private frames = new Map<string, { events: RenderWindowEvents; conn: Conn | null; ready: () => void; fail: (e: Error) => void }>();

  constructor(private readonly tabs: Tabs) {}

  open(events: RenderWindowEvents): RenderWindow {
    const name = randomBytes(12).toString('hex');
    let ready: () => void = () => {};
    let fail: (e: Error) => void = () => {};
    const p = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    this.frames.set(name, { events, conn: null, ready, fail });
    if (!this.tabs.active) fail(new Error('Images and videos are rendered in the browser: open SOMA in a browser tab, then try again.'));
    else this.tabs.request('web:renderOpen', [name]).catch((e: unknown) => fail(e instanceof Error ? e : new Error(String(e))));
    return {
      ready: p,
      send: (job: RenderJob) => this.frames.get(name)?.conn?.send({ t: 'event', ch: 'render:job', args: [job] }),
      close: () => {
        const f = this.frames.get(name);
        this.frames.delete(name);
        f?.fail(new Error('The render window was closed.'));
        f?.conn?.close(1000, 'Closed');
        this.tabs.request('web:renderClose', [name]).catch(() => {});
      },
    };
  }

  /** A message of a render page (send: render:ready, render:done, render:progress). */
  message(conn: Conn, ch: string, args: unknown[]): void {
    const f = this.frames.get(conn.page);
    if (!f) { conn.close(4004, 'Unknown render page'); return; }
    if (f.conn && f.conn !== conn) return;
    f.conn = conn;
    if (ch === 'render:ready') f.ready();
    else if (ch === 'render:done' && typeof args[0] === 'number') f.events.done(args[0], (args[1] ?? { ok: false }) as Parameters<RenderWindowEvents['done']>[1]);
    else if (ch === 'render:progress' && typeof args[0] === 'number') f.events.progress(args[0], Number(args[1]));
  }

  /** The render page is gone (tab closed, taken over, crashed): its jobs fail now. */
  gone(conn: Conn): void {
    const f = this.frames.get(conn.page);
    if (!f || (f.conn && f.conn !== conn)) return;
    f.fail(new Error('The browser tab that renders is gone.'));
    f.events.gone('the browser tab closed');
  }
}
