/*
 * What the user pastes while signing in to SOMA AI where the browser cannot reach pi's callback (the web version), and
 * how a failed sign-in is told. Plain functions without imports, for somaaiauth.ts and its tests.
 */

/** pi's login method: Claude offers a code to copy where its callback cannot be reached, the others have only one. */
export type SignInMethod = 'browser' | 'copy_code';

/** Copy code for Claude when the browser runs elsewhere (the web version), otherwise pi's browser login. */
export function signInMethod(claude: boolean, remoteBrowser: boolean): SignInMethod {
  return claude && remoteBrowser ? 'copy_code' : 'browser';
}

/**
 * The code Anthropic shows: `code#state`, both base64url (the state is pi's PKCE verifier, 43 characters today). The
 * state is required: a code copied without it is cut off, and pi could not tell it belongs to this sign-in.
 */
const CODE = /^[A-Za-z0-9._~-]{8,1000}$/;
const STATE = /^[A-Za-z0-9._~-]{20,200}$/;

/**
 * Whether the pasted text is what pi waits for, before it goes there (a wrong one would end the sign-in):
 * - ChatGPT: the address its page ended at, pi's callback on 127.0.0.1:1455.
 * - Claude, browser login: the address of pi's callback on localhost (53692, another port when taken).
 * - Claude, copy code: the code platform.claude.com shows, `code#state`, or its whole callback address.
 * Only the form: whether the code is right, pi and the provider tell.
 */
export function checkPasted(value: unknown, chatgpt: boolean, method: SignInMethod): { ok: true; value: string } | { ok: false; error: string } {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return { ok: false, error: method === 'copy_code' ? 'Paste the code from the Anthropic page first.' : 'Paste the address first.' };
  let parsed: URL | null = null;
  try { parsed = v.length <= 8000 ? new URL(v) : null; } catch { /* not an address */ }
  const q = parsed?.searchParams;
  const answer = !!q && !!(q.get('error') || (q.get('code') && q.get('state')));
  if (method === 'copy_code') {
    if (parsed) {
      // The address of the page that shows the code, copied instead of the code: pi reads code and state from it
      return parsed.origin === 'https://platform.claude.com' && parsed.pathname === '/oauth/code/callback' && answer
        ? { ok: true, value: v } : { ok: false, error: 'Paste the code the Anthropic page shows after "Authorize" (it looks like abc123…#xyz789…).' };
    }
    const [code, state, more] = v.split('#');
    if (more !== undefined || !CODE.test(code) || state === undefined || !STATE.test(state)) {
      return { ok: false, error: 'That is not the code from the Anthropic page. Copy it with its button there and paste it here (it looks like abc123…#xyz789…).' };
    }
    return { ok: true, value: v };
  }
  const place = chatgpt ? parsed?.origin === 'http://127.0.0.1:1455' && parsed.pathname === '/auth/callback'
    : !!parsed && parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname) && parsed.pathname === '/callback';
  if (!place || !answer) {
    return { ok: false, error: `Paste the whole address the page ended at. It starts with ${chatgpt ? 'http://127.0.0.1:1455/auth/callback?' : 'http://localhost:53692/callback?'}` };
  }
  return { ok: true, value: v };
}

/**
 * A failed sign-in for the window and the log: what pi said, told so the user knows what to do. pi's own messages may
 * carry the provider's answer (`body=…`); that never goes on (it could hold a token), only the reason.
 */
export function signInError(raw: string, label: string, pasted: 'code' | 'address' = 'code'): string {
  const s = raw.trim();
  if (/state mismatch/i.test(s)) {
    return `This ${pasted} belongs to another sign-in. Use the ${pasted} of the ${label} page SOMA opened last, or start signing in again.`;
  }
  if (/Missing authorization code/i.test(s)) return 'The code was missing. Start signing in again and paste the whole code.';
  if (/Token exchange/i.test(s) && /status=429/.test(s)) return `${label} refused for now: too many sign-ins in a short time. Wait a minute, then start signing in again.`;
  if (/Token exchange/i.test(s) && /status=400|invalid_grant/i.test(s)) {
    return `${label} did not accept the code: it may be mistyped, used already or expired (a code is valid only for a few minutes). Start signing in again.`;
  }
  const status = /Token exchange[\s\S]*?status=(\d{3})/i.exec(s)?.[1];
  if (status) return `${label} refused the sign-in (HTTP ${status}). Start signing in again; if it keeps failing, sign in with an API key.`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TimeoutError/i.test(s)) {
    return `${label} could not be reached to finish signing in. Check the internet connection (or the proxy) of the computer SOMA runs on and try again.`;
  }
  // Anything else as pi said it, without the answer of the provider and without pi's stack, and whatever still looks
  // like a token hidden (a message of another form than pi's own)
  const cut = s.split(/;\s*(?:body|details|stack)=/)[0].split(/\r?\n/)[0]
    .replace(/((?:access|refresh|id)_token|token|code|key|secret)("?\s*[:=]\s*"?)[^\s",;}&]+/gi, '$1$2[hidden]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+)/g, '[hidden]');
  return (cut || 'Signing in did not work.').slice(0, 400);
}
