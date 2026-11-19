import type { WsTransport } from './transport';

/*
 * The few things only the browser version shows: the connection to the server, a session taken over by another tab, and
 * what the server asks the browser to do (channels `web:*`). Colors and fonts from the tokens of style.css.
 */

const CSS = `
.web-banner { position:fixed; left:50%; top:10px; transform:translateX(-50%); z-index:10000; padding:6px 12px; border-radius:6px;
  background:var(--s3); border:1px solid var(--warn); color:var(--tx); font:13px/1.4 var(--sans); box-shadow:var(--shadow); }
.web-stop { position:fixed; inset:0; z-index:10001; display:flex; align-items:center; justify-content:center; background:rgba(18,20,23,.92); }
.web-stop > div { max-width:420px; padding:20px 22px; border-radius:8px; background:var(--s2); border:1px solid var(--line2);
  box-shadow:var(--shadow); font:13px/1.5 var(--sans); color:var(--tx); }
.web-stop b { display:block; font-size:15px; margin-bottom:6px; }
.web-stop p { margin:0 0 14px; color:var(--tx2); }
.web-stop button { padding:6px 14px; border-radius:6px; background:var(--acc); color:#1a1206; font-weight:600; }
`;

let styled = false;
function style(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.append(s);
}

let banner: HTMLElement | null = null;
export function showOffline(on: boolean): void {
  style();
  if (!on) { banner?.remove(); banner = null; return; }
  if (banner) return;
  banner = document.createElement('div');
  banner.className = 'web-banner';
  banner.setAttribute('role', 'status');
  banner.textContent = 'Connection to the SOMA server lost. Reconnecting …';
  document.body.append(banner);
}

export function showStopped(reason: 'taken' | 'refused', message?: string): void {
  style();
  showOffline(false);
  const box = document.createElement('div');
  box.className = 'web-stop';
  const inner = document.createElement('div');
  const title = document.createElement('b');
  const text = document.createElement('p');
  const btn = document.createElement('button');
  if (reason === 'taken') {
    title.textContent = 'SOMA is open in another tab';
    text.textContent = 'Only one tab can work with SOMA at a time. Your model stays open, it is shown in the other tab.';
    btn.textContent = 'Use SOMA here';
  } else {
    title.textContent = 'SOMA cannot connect';
    text.textContent = message ?? 'The server does not accept this page.';
    btn.textContent = 'Reload';
  }
  btn.addEventListener('click', () => location.reload());
  inner.append(title, text, btn);
  box.append(inner);
  document.body.append(box);
}

/** Requests of the server that only the browser can carry out. A failure goes back to the main process, as an error. */
export function webRequests(t: WsTransport): void {
  t.onRequest('web:openUrl', (url: unknown) => {
    const u = String(url);
    // As on the desktop only web and mail addresses (commands.ts checks too)
    if (!/^(https?:\/\/|mailto:)/i.test(u)) throw new Error(`Only web and mail addresses can be opened: ${u.slice(0, 100)}`);
    // noopener makes window.open return null in any case: open first, then cut the link back to SOMA
    const w = window.open(u, '_blank');
    if (!w) throw new Error(`The browser blocked the new window. Allow pop-ups for SOMA or open the address yourself: ${u}`);
    w.opener = null;
  });
  // Only under the test harness (web/test/harness-web.mjs), which resizes the page
  t.onRequest('web:testSize', async (w: unknown, h: unknown) => {
    const resize = (window as unknown as { __somaTestSize?: (w: number, h: number) => Promise<void> }).__somaTestSize;
    if (!resize) throw new Error('The page can be resized only by the test harness.');
    await resize(Number(w), Number(h));
  });
  t.onRequest('web:clipboard', async (text: unknown) => {
    if (!navigator.clipboard) throw new Error('The browser allows the clipboard only on https or localhost.');
    await navigator.clipboard.writeText(String(text));
  });
}
