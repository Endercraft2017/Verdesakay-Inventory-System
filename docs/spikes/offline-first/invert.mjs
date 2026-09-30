// Minimal SQLite changeset inverter (format: sqlite.org/sessionintro + session.h docs).
function readVarint(b, p) { let v = 0n; for (let i = 0; i < 9; i++) { const x = b[p++];
  if (i === 8) { v = (v << 8n) | BigInt(x); break; } v = (v << 7n) | BigInt(x & 0x7f); if (!(x & 0x80)) break; }
  return [Number(v), p]; }
function readValue(b, p) { const t = b[p]; const s = p++;
  if (t === 1 || t === 2) p += 8; else if (t === 3 || t === 4) { const [n, q] = readVarint(b, p); p = q + n; }
  else if (t !== 0 && t !== 5) throw new Error('bad value type ' + t + ' at ' + s);
  return [{ t, bytes: b.subarray(s, p) }, p]; }
const UNDEF = { t: 0, bytes: Uint8Array.of(0) };
export function invertChangeset(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); const out = []; let p = 0, nCol = 0, pk = null;
  while (p < b.length) {
    if (b[p] === 0x54) { const s = p; p++; [nCol, p] = readVarint(b, p); pk = b.subarray(p, p + nCol); p += nCol;
      while (b[p] !== 0) p++; p++; out.push(b.subarray(s, p)); continue; }
    const op = b[p], ind = b[p + 1]; p += 2;
    const rec = () => { const r = []; for (let i = 0; i < nCol; i++) { let v; [v, p] = readValue(b, p); r.push(v); } return r; };
    if (op === 18 || op === 9) { const r = rec(); out.push(Uint8Array.of(op === 18 ? 9 : 18, ind), ...r.map(v => v.bytes)); }
    else if (op === 23) { const o = rec(), n = rec();
      const o2 = o.map((v, i) => pk[i] ? v : (n[i].t ? n[i] : UNDEF));
      const n2 = o.map((v, i) => pk[i] ? UNDEF : (n[i].t ? v : UNDEF));
      out.push(Uint8Array.of(23, ind), ...o2.map(v => v.bytes), ...n2.map(v => v.bytes)); }
    else throw new Error('bad op ' + op + ' at ' + (p - 2));
  }
  const len = out.reduce((a, x) => a + x.length, 0), res = new Uint8Array(len); let q = 0;
  for (const x of out) { res.set(x, q); q += x.length; } return res;
}
