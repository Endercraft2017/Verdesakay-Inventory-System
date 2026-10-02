/**
 * Automatic site host election (docs/OFFLINE-FIRST.md §4, §7.6, §31; phase 5b).
 *
 * Only at sites with **3 or more voting PCs** (decision D3): a 1-PC site's PC always hosts, and a
 * 2-PC site's secondary never takes over by itself (an admin can, §30). The election is a small
 * Raft-style state machine:
 *  - the host sends a **heartbeat** every `HEARTBEAT_MS`;
 *  - a PC that hears none for its (randomised) **lease timeout** starts an election: next term,
 *    it votes for itself and asks the others;
 *  - a PC grants **one vote per term**, and only to a candidate at least as caught up as itself
 *    (same host stream and at least as far in it, then app version) — so the winner is never
 *    missing work a voter has;
 *  - a candidate with votes from a **majority of the site's voting PCs** takes over
 *    (`takeOverAsHost`, failover.ts); a LAN split can therefore produce at most one host;
 *  - a heartbeat under a newer term makes a host step down and a PC follow the sender.
 * The cloud stays the referee for terms (§30): a host that later loses its claim there steps down.
 *
 * Messages travel on an `ElectionBus`: in memory for tests, signed UDP on the LAN for the
 * installed app (`udpBus`, keyed by the site's certificate authority, which only the site's PCs
 * hold — an outsider on the LAN can't forge a vote).
 */
import crypto from 'node:crypto';
import dgram from 'node:dgram';

export const HEARTBEAT_MS = 2_000;
export const LEASE_MS = 15_000;

export interface Progress {
  /** The host stream this PC follows (or produces) and how far it is in it. */
  epoch: string | null;
  seq: number;
  version: string;
}

export type ElectionMsg =
  | { t: 'hb'; site: number; term: number; from: number; url: string | null; tenant: string | null }
  | { t: 'ask'; site: number; term: number; from: number; progress: Progress }
  | { t: 'vote'; site: number; term: number; from: number; to: number; granted: boolean };

export interface ElectionBus {
  send(msg: ElectionMsg): void;
  /** Returns an unsubscribe function. */
  onMessage(fn: (msg: ElectionMsg) => void): () => void;
}

export interface ElectionDeps {
  self: number;
  site: number;
  /** The site's voting PCs (this one included, when it votes). */
  voters(): number[];
  isHost(): boolean;
  /** The host this PC follows now (null when it hosts, or doesn't know). */
  currentHost(): number | null;
  term(): number;
  setTerm(term: number): void;
  /** The vote this PC cast in `term`, if any (persisted, so a restart can't vote twice). */
  votedFor(term: number): number | null;
  recordVote(term: number, candidate: number): void;
  progress(): Progress;
  /** This PC's LAN address, announced in its heartbeats as host. */
  address(): { url: string | null; tenant: string | null };
  becomeHost(term: number): Promise<void>;
  /** Follow the host that sent `hb` (a host steps down first). */
  follow(hb: Extract<ElectionMsg, { t: 'hb' }>): void;
  now(): number;
  random(): number;
}

/** Semver-ish compare of app versions ("1.2.10" > "1.2.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Whether a voter may vote for a candidate with `cand` progress, given its own `mine`. */
export function atLeastAsCaughtUp(cand: Progress, mine: Progress): boolean {
  if (cand.epoch && mine.epoch && cand.epoch === mine.epoch && cand.seq < mine.seq) return false;
  return compareVersions(cand.version, mine.version) >= 0;
}

export class SiteElection {
  state: 'follower' | 'candidate' | 'host' = 'follower';
  private lastHeard: number;
  private timeout: number;
  private lastBeat = 0;
  private votes = new Set<number>();
  private electionStarted = 0;
  private busy = false;
  private off: () => void;

  constructor(private deps: ElectionDeps, private bus: ElectionBus) {
    this.lastHeard = deps.now();
    this.timeout = this.newTimeout();
    if (deps.isHost()) this.state = 'host';
    this.off = bus.onMessage((m) => { void this.onMessage(m); });
  }

  stop(): void {
    this.off();
  }

  private newTimeout(): number {
    return LEASE_MS + Math.floor(this.deps.random() * LEASE_MS); // 15–30 s: candidates rarely collide
  }

  /** Whether this site elects automatically at all (D3: 3+ voting PCs). */
  private elects(): boolean {
    return this.deps.voters().length >= 3 && this.deps.voters().includes(this.deps.self);
  }

  /** Call regularly (every few hundred ms). */
  async tick(): Promise<void> {
    const d = this.deps;
    const now = d.now();
    if (d.isHost()) {
      this.state = 'host';
      if (now - this.lastBeat >= HEARTBEAT_MS) {
        this.lastBeat = now;
        const a = d.address();
        this.bus.send({ t: 'hb', site: d.site, term: d.term(), from: d.self, url: a.url, tenant: a.tenant });
      }
      return;
    }
    if (!this.elects() || this.busy) return;
    if (this.state === 'candidate' && now - this.electionStarted >= this.timeout) {
      this.startElection(); // split vote or lost messages: try again under a newer term
    } else if (this.state === 'follower' && now - this.lastHeard >= this.timeout) {
      this.startElection();
    }
  }

  private startElection(): void {
    const d = this.deps;
    const term = d.term() + 1;
    d.setTerm(term);
    d.recordVote(term, d.self);
    this.state = 'candidate';
    this.votes = new Set([d.self]);
    this.electionStarted = d.now();
    this.timeout = this.newTimeout();
    this.bus.send({ t: 'ask', site: d.site, term, from: d.self, progress: d.progress() });
    void this.checkWon(term);
  }

  private async checkWon(term: number): Promise<void> {
    const d = this.deps;
    if (this.state !== 'candidate' || term !== d.term()) return;
    if (this.votes.size * 2 <= d.voters().length) return;
    this.busy = true;
    try {
      await d.becomeHost(term);
      this.state = 'host';
      this.lastBeat = 0;
      await this.tick(); // announce at once
    } finally {
      this.busy = false;
    }
  }

  async onMessage(m: ElectionMsg): Promise<void> {
    const d = this.deps;
    if (m.site !== d.site || m.from === d.self) return;
    if (m.t === 'hb') {
      const mine = d.term();
      if (m.term < mine) return; // a stale host; it steps down when it hears ours
      if (m.term > mine) d.setTerm(m.term);
      this.lastHeard = d.now();
      if (d.isHost()) {
        // A newer term wins. Two hosts under one term can't come from an election (an admin's
        // take-over can cause it): the lower-numbered PC keeps the site.
        if (m.term > mine || m.from < d.self) {
          this.state = 'follower';
          d.follow(m);
        }
        return;
      }
      this.state = 'follower';
      if (d.currentHost() !== m.from) d.follow(m);
      return;
    }
    if (m.t === 'ask') {
      if (m.term > d.term()) {
        d.setTerm(m.term);
        if (this.state === 'candidate') this.state = 'follower';
      }
      const already = d.votedFor(m.term);
      const granted = m.term >= d.term() && (already == null || already === m.from) && !d.isHost()
        && atLeastAsCaughtUp(m.progress, d.progress());
      if (granted) {
        d.recordVote(m.term, m.from);
        this.lastHeard = d.now(); // someone is running: don't start a rival election at once
      }
      this.bus.send({ t: 'vote', site: d.site, term: m.term, from: d.self, to: m.from, granted });
      return;
    }
    if (m.t === 'vote') {
      if (m.to !== d.self || m.term !== d.term() || this.state !== 'candidate' || !m.granted) return;
      this.votes.add(m.from);
      await this.checkWon(m.term);
    }
  }
}

// ---------------------------------------------------------------- buses

/** An in-memory bus for tests: every attached member hears every message but its own. Members
 *  can be cut off (as if switched off or unplugged). */
export class MemoryBus {
  private members = new Map<number, Set<(m: ElectionMsg) => void>>();
  private cut = new Set<number>();
  for(nodeNo: number): ElectionBus {
    return {
      send: (msg) => {
        if (this.cut.has(nodeNo)) return;
        for (const [n, fns] of this.members) {
          if (n === nodeNo || this.cut.has(n)) continue;
          for (const fn of fns) queueMicrotask(() => fn(msg));
        }
      },
      onMessage: (fn) => {
        const set = this.members.get(nodeNo) ?? new Set();
        set.add(fn);
        this.members.set(nodeNo, set);
        return () => set.delete(fn);
      },
    };
  }
  cutOff(nodeNo: number): void { this.cut.add(nodeNo); }
  reconnect(nodeNo: number): void { this.cut.delete(nodeNo); }
}

export const ELECTION_PORT = Number(process.env.SYNC_ELECTION_PORT) || 41234;

/**
 * The installed app's bus: UDP on the LAN — broadcast, plus unicast to each known peer (some
 * networks drop broadcasts). Every message is signed with a key only the site's PCs can derive
 * (from the site's certificate authority) and carries its send time; anything unsigned, forged
 * or older than 30 s is dropped.
 */
export function udpBus(opts: { siteKey: string; peers: () => string[]; port?: number }): ElectionBus & { close(): void } {
  const port = opts.port ?? ELECTION_PORT;
  const key = crypto.createHash('sha256').update('vds-site-election|' + opts.siteKey).digest();
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const listeners = new Set<(m: ElectionMsg) => void>();
  sock.on('message', (buf) => {
    try {
      const { body, sig } = JSON.parse(buf.toString('utf8')) as { body: string; sig: string };
      const want = crypto.createHmac('sha256', key).update(body).digest('hex');
      if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return;
      const { at, msg } = JSON.parse(body) as { at: number; msg: ElectionMsg };
      if (Math.abs(Date.now() - at) > 30_000) return;
      for (const fn of listeners) fn(msg);
    } catch { /* not ours */ }
  });
  sock.on('error', (e) => console.warn('[election] UDP:', e.message));
  sock.bind(port, () => { try { sock.setBroadcast(true); } catch { /* unsupported */ } });
  return {
    send: (msg) => {
      const body = JSON.stringify({ at: Date.now(), msg });
      const out = Buffer.from(JSON.stringify({ body, sig: crypto.createHmac('sha256', key).update(body).digest('hex') }));
      const targets = new Set(['255.255.255.255', ...opts.peers()]);
      for (const ip of targets) sock.send(out, port, ip, () => {});
    },
    onMessage: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    close: () => sock.close(),
  };
}
