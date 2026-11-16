// Unit tests of the web version without a server or browser: message encoding and the checks of the HTTP layer.
// Run with `npm run test:unit` (Node strips the types).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { decode, encode } from '../shared/codec.ts';
import { authorized, sameOrigin } from '../server/http.ts';

test('codec keeps what Electron IPC keeps: undefined, NaN, ArrayBuffer and typed arrays anywhere', () => {
  const glb = new Uint8Array([1, 2, 3, 250]).buffer;
  const value = {
    t: 'event', ch: 'x',
    args: [undefined, null, 1.5, NaN, Infinity, -Infinity, 'text ✓', glb, { batch: { pos: new Float32Array([0.5, -1, 3]), idx: new Uint32Array([7, 8]) } }, [new Uint8Array([9])]],
  };
  const back = decode(encode(value)) as typeof value;
  assert.equal(back.args.length, 10);
  assert.equal(back.args[0], undefined);
  assert.equal(back.args[1], null);
  assert.equal(back.args[2], 1.5);
  assert.ok(Number.isNaN(back.args[3]));
  assert.equal(back.args[4], Infinity);
  assert.equal(back.args[5], -Infinity);
  assert.equal(back.args[6], 'text ✓');
  assert.ok(back.args[7] instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(back.args[7] as ArrayBuffer)], [1, 2, 3, 250]);
  const batch = (back.args[8] as { batch: { pos: Float32Array; idx: Uint32Array } }).batch;
  assert.ok(batch.pos instanceof Float32Array);
  assert.deepEqual([...batch.pos], [0.5, -1, 3]);
  assert.ok(batch.idx instanceof Uint32Array);
  assert.deepEqual([...batch.idx], [7, 8]);
  assert.ok((back.args[9] as Uint8Array[])[0] instanceof Uint8Array);
});

test('codec: Node Buffer arrives as Uint8Array, a view on a larger buffer only with its own bytes', () => {
  const big = Buffer.from('0123456789');
  const back = decode(encode([big.subarray(2, 5)])) as Uint8Array[];
  assert.equal(back[0].constructor, Uint8Array);
  assert.equal(Buffer.from(back[0]).toString(), '234');
});

test('codec: top-level undefined and empty values', () => {
  assert.equal(decode(encode(undefined)), undefined);
  assert.deepEqual(decode(encode([])), []);
  assert.deepEqual(decode(encode({})), {});
});

test('codec refuses truncated and damaged frames', () => {
  const f = encode({ a: new Uint8Array(100) });
  assert.throws(() => decode(f.subarray(0, f.byteLength - 1)), /Truncated/);
  assert.throws(() => decode(new Uint8Array([255, 255, 255, 255])), /Truncated/);
});

const req = (headers: Record<string, string>) => ({ headers, socket: {} }) as unknown as IncomingMessage;

test('authorized: only the cookie derived from the token, proxy mode lets everything through', () => {
  assert.equal(authorized(req({}), { kind: 'token', token: 'abc' }), false);
  assert.equal(authorized(req({ cookie: 'soma_session=abc' }), { kind: 'token', token: 'abc' }), false, 'the token itself is not the cookie');
  const good = createHmac('sha256', 'abc').update('soma-web-session').digest('base64url');
  assert.equal(authorized(req({ cookie: `other=1; soma_session=${good}` }), { kind: 'token', token: 'abc' }), true);
  assert.equal(authorized(req({ cookie: `soma_session=${good}` }), { kind: 'token', token: 'abd' }), false);
  assert.equal(authorized(req({}), { kind: 'proxy' }), true);
});

test('sameOrigin: the WebSocket only from the page of this server', () => {
  assert.equal(sameOrigin(req({ host: 'localhost:5173', origin: 'http://localhost:5173' }), []), true);
  assert.equal(sameOrigin(req({ host: 'localhost:5173', origin: 'http://evil.example' }), []), false);
  assert.equal(sameOrigin(req({ host: 'localhost:5173' }), []), false, 'without Origin no WebSocket');
  assert.equal(sameOrigin(req({ host: '127.0.0.1:5173', 'x-forwarded-host': 'coder.example', origin: 'https://coder.example' }), []), true);
  assert.equal(sameOrigin(req({ host: '127.0.0.1:5173', origin: 'https://other.example' }), ['https://other.example']), true);
});

test('codec: a frame read from a Node Buffer (as the server gets it) keeps exactly its bytes', () => {
  const pool = Buffer.alloc(4096, 7);
  const frame = encode({ png: new Uint8Array([137, 80, 78, 71]) });
  frame.forEach((b, i) => { pool[100 + i] = b; });
  const back = decode(pool.subarray(100, 100 + frame.byteLength)) as { png: Uint8Array };
  assert.equal(back.png.buffer.byteLength, 4);
  assert.deepEqual([...back.png], [137, 80, 78, 71]);
});

test('codec: an object of the app with the marker key stays an object', () => {
  const v = { '__soma$': 'u', other: 1, nested: { '__soma$': 'b', i: 3 } };
  assert.deepEqual(decode(encode(v)), v);
});
