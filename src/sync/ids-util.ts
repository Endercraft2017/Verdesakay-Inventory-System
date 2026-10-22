/**
 * Identity + ordering primitives for sync commands (docs/OFFLINE-FIRST.md §2.1):
 * ULIDs for command ids and a hybrid logical clock for ordering across PCs whose clocks drift.
 */
import crypto from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26-char ULID: 48-bit ms timestamp + 80 random bits, lexicographically time-ordered. */
export function ulid(ms = Date.now()): string {
  let time = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! & 31];
  return time + rand;
}

/** A hybrid logical clock value: wall ms, a logical counter for events in the same ms (or
 *  when the wall clock went backwards), and the node number as the final tie-breaker. */
export interface Hlc {
  ms: number;
  counter: number;
  node: number;
}

/** Fixed-width text form, so string order == clock order. */
export function formatHlc(h: Hlc): string {
  return `${String(h.ms).padStart(15, '0')}:${String(h.counter).padStart(5, '0')}:${String(h.node).padStart(5, '0')}`;
}

export function parseHlc(s: string): Hlc {
  const [ms, counter, node] = s.split(':').map(Number);
  return { ms: ms!, counter: counter!, node: node! };
}

/** Next clock value for a local event: never behind the last one, even if the PC clock is. */
export function tickHlc(last: Hlc | null, node: number, wallMs = Date.now()): Hlc {
  if (!last || wallMs > last.ms) return { ms: wallMs, counter: 0, node };
  return { ms: last.ms, counter: last.counter + 1, node };
}

/** Merge a clock value seen from elsewhere, so later local events order after it. */
export function receiveHlc(last: Hlc | null, remote: Hlc, node: number, wallMs = Date.now()): Hlc {
  const ms = Math.max(wallMs, last?.ms ?? 0, remote.ms);
  let counter = 0;
  if (ms === last?.ms && ms === remote.ms) counter = Math.max(last.counter, remote.counter) + 1;
  else if (ms === last?.ms) counter = last.counter + 1;
  else if (ms === remote.ms) counter = remote.counter + 1;
  return { ms, counter, node };
}
