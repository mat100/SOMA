// The test suites of the desktop app (app/test/*.mjs) against the web version: app/test/harness.mjs hands startApp() over
// to here with SOMA_TEST_TARGET=web. Same object as for Electron (ev, waitFor, domClick, answers, screenshot, crash, stop),
// only the window is a page in Chromium (Playwright) and the main process is the web server, both in test mode.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const WEB = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/** Same options as startApp of app/test/harness.mjs; `port` is ignored (the server picks a free one). */
export async function startWebApp({ userData, watchdogMs = (Number(process.env.SOMA_TEST_WATCHDOG_S) || 6 * 60) * 1000, name = 'test', env = {} } = {}) {
  const ud = userData ?? fs.mkdtempSync(path.join(os.tmpdir(), `soma-web-${name}-`));
  const port = await freePort();
  const token = randomBytes(12).toString('hex');
  const server = spawn(process.execPath, [path.join(WEB, 'bin', 'soma-web.cjs')], {
    env: { ...process.env, SOMA_USER_DATA: ud, SOMA_TEST: '1', SOMA_WEB_PORT: String(port), SOMA_WEB_TOKEN: token, SOMA_WEB_FILES: ud, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const kill = () => { try { server.kill('SIGKILL'); } catch { /* gone */ } };
  for (const t0 = Date.now(); !log.includes('[web] SOMA');) {
    if (server.exitCode !== null || Date.now() - t0 > 60000) { kill(); throw new Error(`Web server did not start. ${log.slice(-600)}`); }
    await sleep(100);
  }

  // WebGL without a GPU (CI, containers): SwiftShader, as the desktop tests use llvmpipe under xvfb
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
  const p = await context.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const dog = setTimeout(() => { console.log('ABBRUCH: Watchdog'); kill(); void browser.close(); process.exit(1); }, watchdogMs);
  dog.unref();
  await p.goto(`http://127.0.0.1:${port}/?token=${token}`);

  // What app/test/cdp.mjs offers for the Electron window
  const page = {
    errors,
    // As CDP with returnByValue (app/test/cdp.mjs): the value as JSON, so NaN in an object is null there as well
    evaluate: async (fn, arg) => { const v = await p.evaluate(fn, arg ?? null); return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },
    click: (x, y) => p.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      if (!target) return false;
      const init = { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true };
      target.dispatchEvent(new PointerEvent('pointerdown', init));
      target.dispatchEvent(new PointerEvent('pointerup', init));
      target.dispatchEvent(new MouseEvent('click', init));
      return true;
    }, { x, y }),
    screenshot: (file) => p.screenshot({ path: file }),
    close: () => { void browser.close().catch(() => {}); },
    /** Playwright's page, for what only the web suites need. */
    playwright: p,
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  return {
    ud, page, ev, visible: false, log: () => log, web: true,
    async waitFor(desc, fn, timeout = 60000, arg) {
      const t0 = Date.now();
      for (;;) {
        try { const v = await ev(fn, arg); if (v) return v; } catch { /* page still loading */ }
        if (Date.now() - t0 > timeout) throw new Error(`Zeitüberschreitung: ${desc}`);
        await sleep(200);
      }
    },
    domClick: (id) => ev((i) => document.getElementById(i).click(), id),
    answers: (list) => ev((a) => window.soma.test.answers(a), list),
    /** Screenshot of the page, with `rect` (CSS pixels) only that part. Same answer as Electron's: the size. */
    async screenshot(file, rect) {
      await p.screenshot({ path: file, ...(rect ? { clip: rect } : {}) });
      return rect ? { width: rect.width, height: rect.height } : { width: 1600, height: 950 };
    },
    crash() { clearTimeout(dog); page.close(); kill(); },
    async stop() { clearTimeout(dog); await browser.close().catch(() => {}); kill(); await sleep(300); },
  };
}
