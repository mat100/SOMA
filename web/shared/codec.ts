/**
 * Messages between the browser tab and the server, one binary WebSocket frame each. Electron's IPC copies values with the
 * structured clone algorithm, the main process and the renderer rely on that: ArrayBuffer and typed arrays anywhere in a
 * value (models as GLB, DXF batches), `undefined` as an argument, NaN. JSON alone loses all three. So binary data goes
 * after the JSON as raw bytes and the JSON holds a marker in its place.
 *
 * Frame: 4 bytes length of the JSON (little endian), the JSON as UTF-8, then the binary parts one after the other.
 */

const MARK = '__soma$';
/** `o`: an object of the app that itself has the key MARK, as a list of entries, so it stays what it is. */
type Marker = { [MARK]: 'u' } | { [MARK]: 'n'; v: string } | { [MARK]: 'b'; i: number; t: string } | { [MARK]: 'o'; e: [string, unknown][] };

const VIEWS = {
  Uint8Array, Int8Array, Uint8ClampedArray, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
} as const;
type ViewName = keyof typeof VIEWS;

export function encode(value: unknown): Uint8Array {
  const parts: Uint8Array[] = [];
  const json = JSON.stringify(value, function (this: Record<string, unknown>, key, after: unknown) {
    // The value before toJSON: Node's Buffer would already be { type: 'Buffer', data: [...] }
    const v = this[key];
    if (v === undefined) return { [MARK]: 'u' } satisfies Marker;
    if (typeof v === 'number' && !Number.isFinite(v)) return { [MARK]: 'n', v: String(v) } satisfies Marker;
    if (v instanceof ArrayBuffer) { parts.push(new Uint8Array(v)); return { [MARK]: 'b', i: parts.length - 1, t: 'ArrayBuffer' } satisfies Marker; }
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      // Node's Buffer is a Uint8Array and arrives as one, as over IPC
      const name = (Object.keys(VIEWS) as ViewName[]).find((n) => v instanceof VIEWS[n]) ?? 'Uint8Array';
      parts.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      return { [MARK]: 'b', i: parts.length - 1, t: name } satisfies Marker;
    }
    if (after && typeof after === 'object' && !Array.isArray(after) && Object.hasOwn(after, MARK)) return { [MARK]: 'o', e: Object.entries(after) } satisfies Marker;
    return after;
  }) ?? 'null';
  const head = new TextEncoder().encode(json);
  // Lengths of the binary parts lead, so the reader can cut them apart
  const lengths = new Uint32Array(parts.map((p) => p.byteLength));
  const total = 4 + head.byteLength + 4 + lengths.byteLength + parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let at = 0;
  dv.setUint32(at, head.byteLength, true); at += 4;
  out.set(head, at); at += head.byteLength;
  dv.setUint32(at, parts.length, true); at += 4;
  for (const n of lengths) { dv.setUint32(at, n, true); at += 4; }
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

export function decode(frame: ArrayBuffer | Uint8Array): unknown {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n: number) => { if (at + n > bytes.byteLength) throw new Error('Truncated message.'); };
  need(4);
  const headLen = dv.getUint32(at, true); at += 4;
  need(headLen);
  const json = new TextDecoder().decode(bytes.subarray(at, at + headLen)); at += headLen;
  need(4);
  const count = dv.getUint32(at, true); at += 4;
  need(count * 4);
  const lengths: number[] = [];
  for (let i = 0; i < count; i++) { lengths.push(dv.getUint32(at, true)); at += 4; }
  const parts: ArrayBuffer[] = [];
  for (const n of lengths) {
    need(n);
    // A copy of its own per part: receivers may keep or transfer the buffer. new Uint8Array(view) copies; slice() of a
    // Node Buffer would not, its .buffer is the whole (pooled) memory
    parts.push(new Uint8Array(bytes.subarray(at, at + n)).buffer);
    at += n;
  }
  const revive = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(revive);
    if (!v || typeof v !== 'object') return v;
    const m = v as Partial<Record<typeof MARK, string>> & { v?: string; i?: number; t?: string; e?: [string, unknown][] };
    if (m[MARK] === 'u') return undefined;
    if (m[MARK] === 'n') return Number(m.v);
    if (m[MARK] === 'o') return Object.fromEntries((m.e ?? []).map(([k, x]) => [k, revive(x)]));
    if (m[MARK] === 'b') {
      const buf = parts[m.i ?? -1];
      if (!buf) throw new Error('Missing binary part.');
      if (m.t === 'ArrayBuffer') return buf;
      const View = VIEWS[m.t as ViewName];
      if (!View) throw new Error(`Unknown binary type ${String(m.t)}.`);
      return new View(buf);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = revive(x);
    return out;
  };
  return revive(JSON.parse(json));
}
