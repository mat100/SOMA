import type { WsTransport } from './transport';

/*
 * Hidden frames that render images and videos for `soma render` (web/server/render.ts). Out of sight but not hidden from
 * the browser: a frame that is display:none or invisible may not draw at all.
 */

const frames = new Map<string, HTMLIFrameElement>();

/** This tab no longer has the session: its render frames end (the server has given up their jobs). */
export function removeRenderFrames(): void {
  for (const f of frames.values()) f.remove();
  frames.clear();
}

export function renderFrames(t: WsTransport): void {
  t.onRequest('web:renderOpen', (name) => {
    const n = String(name);
    if (!/^[a-f0-9]{8,64}$/.test(n) || frames.has(n)) throw new Error('Bad render page name.');
    const f = document.createElement('iframe');
    f.src = `render.html?w=${n}`;
    f.title = 'SOMA Render';
    f.setAttribute('aria-hidden', 'true');
    f.tabIndex = -1;
    // Size of the render window on the desktop (render.ts in app/src/main), far left of the page
    Object.assign(f.style, { position: 'fixed', left: '-20000px', top: '0', width: '1280px', height: '800px', border: '0', pointerEvents: 'none' });
    document.body.append(f);
    frames.set(n, f);
  });
  t.onRequest('web:renderClose', (name) => {
    frames.get(String(name))?.remove();
    frames.delete(String(name));
  });
}
