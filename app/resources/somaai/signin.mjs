// "Sign in with ChatGPT" for SOMA AI (app/src/main/somaaiauth.ts) with pi's SDK: ModelRuntime.login, the same call as
// `pi auth login`. pi's command needs a terminal, and the Electron of the app has none (a Windows GUI program), so
// SOMA runs this over pipes with ELECTRON_RUN_AS_NODE=1 and PI_CODING_AGENT_DIR set.
// Arguments: pi's bundle (index.js), auth.json, provider, device id. Lines on stdout are JSON: {url}, {info}, {ok},
// {error}. Closing stdin cancels. A line {code} on stdin is the address the sign-in page ended at, pasted by the user
// where the browser cannot reach pi's callback (the web version). SOMA introduces itself as "SOMA AI" (OpenAI shows the
// name when asking for consent).
import { pathToFileURL } from 'node:url';

const [, , piIndex, authPath, provider, deviceId] = process.argv;
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const cancel = new AbortController();
process.stdin.on('end', () => cancel.abort());
process.stdin.on('error', () => cancel.abort());
process.stdin.setEncoding('utf8');
/** Waiting for a pasted address (pi's manual_code prompt), or one pasted before pi asked. */
let pasted = null;
let early = null;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      if (typeof m.code !== 'string') continue;
      if (pasted) pasted(m.code); else early = m.code;
    } catch { /* not for us */ }
  }
});

/**
 * A question pi asks on the command line (paste the address by hand): the browser callback answers it, or the address
 * SOMA passes on (stdin). SOMA checks its form first (somaaiauth.ts): pi ends the sign-in at a wrong one.
 */
const waitForCallback = (signal, manual) => new Promise((resolve, reject) => {
  for (const s of [signal, cancel.signal].filter(Boolean)) s.addEventListener('abort', () => reject(new Error('Login cancelled')), { once: true });
  if (manual && early) { resolve(early); early = null; } else if (manual) pasted = (code) => { pasted = null; resolve(code); };
});

try {
  const { ModelRuntime } = await import(pathToFileURL(piIndex).href);
  const runtime = await ModelRuntime.create({ authPath, refreshOnCreate: false });
  await runtime.login(provider, 'oauth', {
    signal: cancel.signal,
    prompt: (p) => (p.type === 'select' ? Promise.resolve(p.options[0].id) : waitForCallback(p.signal, p.type === 'manual_code')),
    notify: (e) => {
      if (e.type === 'auth_url') say({ url: e.url });
      else if (e.type === 'device_code') say({ url: e.verificationUri, code: e.userCode });
      else if (e.message) say({ info: e.message });
    },
  }, { getDeviceId: () => deviceId, agentName: 'SOMA AI' });
  say({ ok: true });
  process.exit(0);
} catch (e) {
  say({ error: cancel.signal.aborted ? 'cancelled' : e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
