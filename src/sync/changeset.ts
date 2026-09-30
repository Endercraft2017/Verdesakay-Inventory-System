/**
 * SQLite changeset utilities node:sqlite doesn't provide: invert (roll back a node's
 * optimistic work during rebase) and table filtering (keep node-local tables out of what
 * replicates). Works on the documented binary format (sqlite.org/session/changegroup +
 * session.h): per table a 'T' header (column count, primary-key flags, name), then change
 * records — op (INSERT 18 / DELETE 9 / UPDATE 23), indirect flag, then values.
 * Proven in docs/spikes/offline-first/ (OFFLINE-FIRST §9).
 */

const OP_INSERT = 18;
const OP_DELETE = 9;
const OP_UPDATE = 23;
const TABLE = 0x54; // 'T'

interface Value {
  type: number; // 0 undefined, 1 int, 2 real, 3 text, 4 blob, 5 null
  bytes: Uint8Array;
}
const UNDEFINED: Value = { type: 0, bytes: Uint8Array.of(0) };

function readVarint(b: Uint8Array, p: number): [number, number] {
  let v = 0n;
  for (let i = 0; i < 9; i++) {
    const x = b[p++]!;
    if (i === 8) {
      v = (v << 8n) | BigInt(x);
      break;
    }
    v = (v << 7n) | BigInt(x & 0x7f);
    if (!(x & 0x80)) break;
  }
  return [Number(v), p];
}

function readValue(b: Uint8Array, p: number): [Value, number] {
  const type = b[p]!;
  const start = p++;
  if (type === 1 || type === 2) p += 8;
  else if (type === 3 || type === 4) {
    const [n, q] = readVarint(b, p);
    p = q + n;
  } else if (type !== 0 && type !== 5) throw new Error(`Malformed changeset: value type ${type} at ${start}`);
  return [{ type, bytes: b.subarray(start, p) }, p];
}

interface TableBlock {
  name: string;
  header: Uint8Array;
  pk: Uint8Array;
  changes: Array<{ op: number; indirect: number; values: Value[][] }>;
}

function parse(buf: Uint8Array): TableBlock[] {
  const b = buf;
  const blocks: TableBlock[] = [];
  let p = 0;
  let cur: TableBlock | null = null;
  let nCol = 0;
  while (p < b.length) {
    if (b[p] === TABLE) {
      const start = p++;
      [nCol, p] = readVarint(b, p);
      const pk = b.subarray(p, p + nCol);
      p += nCol;
      const nameStart = p;
      while (b[p] !== 0) p++;
      const name = Buffer.from(b.subarray(nameStart, p)).toString('utf8');
      p++;
      cur = { name, header: b.subarray(start, p), pk, changes: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) throw new Error('Malformed changeset: change before table header');
    const op = b[p]!;
    const indirect = b[p + 1]!;
    p += 2;
    const record = (): Value[] => {
      const r: Value[] = [];
      for (let i = 0; i < nCol; i++) {
        let v: Value;
        [v, p] = readValue(b, p);
        r.push(v);
      }
      return r;
    };
    if (op === OP_INSERT || op === OP_DELETE) cur.changes.push({ op, indirect, values: [record()] });
    else if (op === OP_UPDATE) cur.changes.push({ op, indirect, values: [record(), record()] });
    else throw new Error(`Malformed changeset: op ${op} at ${p - 2}`);
  }
  return blocks;
}

function serialize(blocks: TableBlock[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const blk of blocks) {
    if (!blk.changes.length) continue;
    parts.push(blk.header);
    for (const c of blk.changes) {
      parts.push(Uint8Array.of(c.op, c.indirect));
      for (const rec of c.values) for (const v of rec) parts.push(v.bytes);
    }
  }
  return Buffer.concat(parts);
}

/** The changeset that undoes `buf`: inserts become deletes, deletes inserts, updates swap
 *  old and new values (same rule as sqlite3changeset_invert). */
export function invertChangeset(buf: Uint8Array): Uint8Array {
  const blocks = parse(buf);
  for (const blk of blocks) {
    blk.changes = blk.changes.map((c) => {
      if (c.op === OP_INSERT) return { ...c, op: OP_DELETE };
      if (c.op === OP_DELETE) return { ...c, op: OP_INSERT };
      const [oldRec, newRec] = c.values as [Value[], Value[]];
      const inv0 = oldRec.map((v, i) => (blk.pk[i] ? v : newRec[i]!.type ? newRec[i]! : UNDEFINED));
      const inv1 = oldRec.map((v, i) => (blk.pk[i] ? UNDEFINED : newRec[i]!.type ? v : UNDEFINED));
      return { ...c, values: [inv0, inv1] };
    });
  }
  return serialize(blocks);
}

/** Only the changes to tables `keep` accepts (an empty result is a zero-length changeset). */
export function filterChangeset(buf: Uint8Array, keep: (table: string) => boolean): Uint8Array {
  return serialize(parse(buf).filter((blk) => keep(blk.name)));
}

/** Tables a changeset touches, with how many rows each. */
export function changesetTables(buf: Uint8Array): Record<string, number> {
  const out: Record<string, number> = {};
  for (const blk of parse(buf)) out[blk.name] = (out[blk.name] ?? 0) + blk.changes.length;
  return out;
}
