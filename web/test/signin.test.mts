// Sign-in of SOMA AI in the web version: what the user may paste, how failures are told, and signin.mjs (the helper that
// runs pi's login) with a pi of our own: the method SOMA asks for is the one pi gets, a pasted code reaches it.
// Run with `npm run test:unit` (Node strips the types).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPasted, signInError, signInMethod } from '../../app/src/main/signincode.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIGNIN = path.resolve(HERE, '..', '..', 'app', 'resources', 'somaai', 'signin.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-signin-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('method: copy code only for Claude with the browser elsewhere (web), the desktop stays on the browser login', () => {
  assert.equal(signInMethod(true, true), 'copy_code');
  assert.equal(signInMethod(true, false), 'browser');
  assert.equal(signInMethod(false, true), 'browser', 'ChatGPT has no code to copy');
  assert.equal(signInMethod(false, false), 'browser');
});

test('pasted Claude code: code#state, the code alone, or the address of the code page; nothing else reaches pi', () => {
  const code = 'Ab3_de-fG7hIjK9lMnOp#q1W2e3R4t5Y6u7I8o9P0';
  assert.deepEqual(checkPasted(`  ${code}\n`, false, 'copy_code'), { ok: true, value: code });
  assert.equal(checkPasted('https://platform.claude.com/oauth/code/callback?code=abcdefgh123&state=ijklmnop456', false, 'copy_code').ok, true);
  for (const bad of ['', 'Ab3_de-fG7hIjK9l', 'Ab3_de-fG7hIjK9l#short', 'short#q1W2e3R4t5Y6u7I8o9P0', 'a b c d e f g h#q1W2e3R4t5Y6u7I8o9P0', 'abcdefgh123#q1W2e3R4t5Y6u7I8o9P0#more', 'abcdefgh<script>#q1W2e3R4t5Y6u7I8o9P0',
    'http://localhost:53692/callback?code=abcdefgh&state=ijklmnop', 'https://example.com/oauth/code/callback?code=abcdefgh&state=ij',
    'https://platform.claude.com/oauth/code/callback', 42, null]) {
    const r = checkPasted(bad, false, 'copy_code');
    assert.equal(r.ok, false, `refused: ${String(bad)}`);
    assert.ok(!r.ok && /code/i.test(r.error), 'says to paste the code');
  }
});

test('pasted addresses for the browser login stay as they were: ChatGPT on 127.0.0.1:1455, Claude on localhost', () => {
  assert.equal(checkPasted('http://127.0.0.1:1455/auth/callback?code=a&state=b', true, 'browser').ok, true);
  assert.equal(checkPasted('http://localhost:53692/callback?code=a&state=b', true, 'browser').ok, false);
  assert.equal(checkPasted('http://localhost:53692/callback?code=a&state=b', false, 'browser').ok, true);
  assert.equal(checkPasted('http://127.0.0.1:40111/callback?error=access_denied', false, 'browser').ok, true);
  const r = checkPasted('https://example.com/', true, 'browser');
  assert.ok(!r.ok && r.error.includes('http://127.0.0.1:1455/auth/callback?'));
});

test('failures in words, and never what the provider answered (it could hold a token)', () => {
  assert.match(signInError('OAuth state mismatch', 'Claude'), /This code belongs to another sign-in/);
  assert.match(signInError('OAuth state mismatch', 'ChatGPT', 'address'), /This address belongs to another sign-in/);
  const rejected = 'Token exchange request failed. url=https://platform.claude.com/v1/oauth/token; redirect_uri=https://platform.claude.com/oauth/code/callback; '
    + 'response_type=authorization_code; details=Error: HTTP request failed. status=400; url=x; body={"error":"invalid_grant","access_token":"sk-SECRET"}';
  const told = signInError(rejected, 'Claude');
  assert.match(told, /did not accept the code.*expired/);
  assert.ok(!told.includes('SECRET'));
  assert.match(signInError('Token exchange request failed. details=TypeError: fetch failed; cause=Error: getaddrinfo ENOTFOUND platform.claude.com', 'Claude'), /could not be reached/);
  const other = signInError('Token exchange returned invalid JSON. url=x; body={"access_token":"sk-SECRET"}; details=SyntaxError', 'Claude');
  assert.ok(!other.includes('SECRET'), other);
  // A message of another form (stderr of a crash) with a token in it: hidden
  const odd = signInError('Error: unexpected {"access_token":"sk-ant-oat01-SECRET123","refresh_token":"sk-ant-ort01-SECRET456"}', 'Claude');
  assert.ok(!odd.includes('SECRET'), odd);
  assert.match(signInError('Token exchange request failed. details=HTTP request failed. status=429; body={}', 'Claude'), /too many sign-ins/);
  assert.match(signInError('Token exchange request failed. details=HTTP request failed. status=401; body={}', 'Claude'), /refused the sign-in \(HTTP 401\)/);
  assert.equal(signInError('', 'Claude'), 'Signing in did not work.');
});

/**
 * A pi of our own for signin.mjs: the login asks for the method as pi does for Claude, names the page, and with copy code
 * waits for the code. `good-code-123#<state>` signs in, another state is pi's state mismatch, `expired-code-1` is refused
 * as Anthropic refuses a stale code.
 */
const fakePi = path.join(tmp, 'pi', 'index.js');
fs.mkdirSync(path.dirname(fakePi), { recursive: true });
fs.writeFileSync(fakePi, `
import fs from 'node:fs';
export const ModelRuntime = {
  async create({ authPath }) {
    return {
      async login(provider, type, interaction) {
        const method = await interaction.prompt({ type: 'select', message: 'Select Anthropic login method:',
          options: [{ id: 'browser', label: 'Browser login (default)' }, { id: 'copy_code', label: 'Copy code login (headless)' }] });
        const state = 'the-state-0123';
        const redirect = method === 'copy_code' ? 'https://platform.claude.com/oauth/code/callback' : 'http://localhost:53692/callback';
        interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?redirect_uri=' + encodeURIComponent(redirect) + '&state=' + state });
        const input = await interaction.prompt({ type: 'manual_code', message: 'Paste', signal: interaction.signal });
        const [code, st] = input.split('#');
        if (st && st !== state) throw new Error('OAuth state mismatch');
        if (code === 'expired-code-1') throw new Error('Token exchange request failed. details=HTTP request failed. status=400; body={"error":"invalid_grant"}');
        fs.writeFileSync(authPath, JSON.stringify({ [provider]: { type, method, access: 'tok' } }));
      },
    };
  },
};
`);

/** Runs signin.mjs with the fake pi; `answer` gets the page's address and returns what the user pastes. */
function runSignIn(method: string | null, answer: (url: string) => string): Promise<{ lines: Record<string, unknown>[]; code: number | null; auth: string }> {
  const auth = path.join(tmp, `auth-${Math.random().toString(36).slice(2)}.json`);
  const args = [SIGNIN, fakePi, auth, 'anthropic', 'device-1', ...(method ? [method] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: Record<string, unknown>[] = [];
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const m = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
        buf = buf.slice(i + 1);
        lines.push(m);
        if (typeof m.url === 'string') child.stdin.write(`${JSON.stringify({ code: answer(m.url) })}\n`);
      }
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('signin.mjs did not end')); }, 20_000);
    child.once('close', (code) => { clearTimeout(timer); resolve({ lines, code, auth: fs.existsSync(auth) ? fs.readFileSync(auth, 'utf8') : '' }); });
  });
}

test('signin.mjs: copy code when asked, the pasted code reaches pi and the sign-in is saved', async () => {
  const r = await runSignIn('copy_code', (url) => {
    assert.match(url, /redirect_uri=https%3A%2F%2Fplatform\.claude\.com%2Foauth%2Fcode%2Fcallback/);
    return 'good-code-123#the-state-0123';
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines.at(-1), { ok: true });
  assert.equal(JSON.parse(r.auth).anthropic.method, 'copy_code');
});

test('signin.mjs: without a method the browser login, as on the desktop', async () => {
  const r = await runSignIn(null, (url) => {
    assert.match(url, /redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback/);
    return 'good-code-123#the-state-0123';
  });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.auth).anthropic.method, 'browser');
});

test('signin.mjs: a wrong or stale code ends with pi\'s error, nothing saved', async () => {
  const wrong = await runSignIn('copy_code', () => 'good-code-123#another-state');
  assert.equal(wrong.code, 1);
  assert.match(String(wrong.lines.at(-1)?.error), /state mismatch/);
  assert.equal(wrong.auth, '');
  const stale = await runSignIn('copy_code', () => 'expired-code-1#the-state-0123');
  assert.equal(stale.code, 1);
  assert.match(signInError(String(stale.lines.at(-1)?.error), 'Claude'), /did not accept the code/);
  assert.equal(stale.auth, '');
});
