/**
 * Automatic site host election (src/sync/election.ts; docs/OFFLINE-FIRST.md §4, §7.6, §31): the
 * state machine on its own — fake clock, in-memory LAN. Majority wins; a split minority can't
 * elect; one vote per term; voters never pick a PC that is behind them; a 2-PC site never elects
 * by itself (D3); a host that hears a newer term steps down; signed UDP rejects forgeries.
 */
import { describe, it, expect } from 'vitest';
import {
  HEARTBEAT_MS, LEASE_MS, MemoryBus, SiteElection, atLeastAsCaughtUp, compareVersions, udpBus,
  type ElectionMsg, type Progress,
} from '../src/sync/election';

interface FakePc {
  no: number;
  term: number;
  votes: Map<number, number>;
  host: boolean;
  following: number | null;
  progress: Progress;
  voting: boolean;
  election?: SiteElection;
  becameHostAt: number[];
}

function site(n: number, opts: { hostNo?: number; voting?: (no: number) => boolean; seq?: (no: number) => number } = {}) {
  let clock = 0;
  let seed = 7;
  const bus = new MemoryBus();
  const pcs: FakePc[] = [];
  for (let i = 1; i <= n; i++) {
    pcs.push({
      no: i, term: 1, votes: new Map(), host: i === (opts.hostNo ?? 1), following: (opts.hostNo ?? 1),
      progress: { epoch: 'e1', seq: opts.seq ? opts.seq(i) : 10, version: '1.0.0' },
      voting: opts.voting ? opts.voting(i) : true, becameHostAt: [],
    });
  }
  for (const pc of pcs) {
    pc.election = new SiteElection({
      self: pc.no, site: 1,
      voters: () => pcs.filter((p) => p.voting).map((p) => p.no),
      isHost: () => pc.host,
      currentHost: () => (pc.host ? null : pc.following),
      term: () => pc.term,
      setTerm: (t) => { pc.term = t; },
      votedFor: (t) => pc.votes.get(t) ?? null,
      recordVote: (t, c) => { pc.votes.set(t, c); },
      progress: () => pc.progress,
      address: () => ({ url: `https://pc${pc.no}:3000`, tenant: null }),
      becomeHost: async (t) => { pc.host = true; pc.following = null; pc.becameHostAt.push(t); },
      follow: (hb: Extract<ElectionMsg, { t: 'hb' }>) => { pc.host = false; pc.following = hb.from; },
      now: () => clock,
      random: () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; },
    }, bus.for(pc.no));
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    pcs, bus,
    /** Let `ms` pass, ticking every 250 ms. */
    async run(ms: number) {
      for (let t = 0; t < ms; t += 250) {
        clock += 250;
        for (const pc of pcs) if (!bus['cut'].has(pc.no)) await pc.election!.tick();
        await flush();
        await flush();
      }
    },
    hosts: () => pcs.filter((p) => p.host && !bus['cut'].has(p.no)).map((p) => p.no),
  };
}

describe('the election', () => {
  it('a healthy host keeps the site: its heartbeats stop any election', async () => {
    const s = site(3);
    await s.run(LEASE_MS * 4);
    expect(s.hosts()).toEqual([1]);
    expect(s.pcs.map((p) => p.term)).toEqual([1, 1, 1]);
  });

  it('the host dies: the others elect exactly one new host, under a newer term, and it is followed', async () => {
    const s = site(3);
    await s.run(HEARTBEAT_MS * 2);
    s.bus.cutOff(1);
    await s.run(LEASE_MS * 4);
    const hosts = s.hosts();
    expect(hosts).toHaveLength(1);
    const winner = s.pcs.find((p) => p.no === hosts[0])!;
    expect(winner.term).toBeGreaterThan(1);
    const other = s.pcs.find((p) => p.no !== 1 && p.no !== winner.no)!;
    expect(other.following).toBe(winner.no);
    expect(other.term).toBe(winner.term);
  });

  it('the old host comes back and steps down when it hears the newer term', async () => {
    const s = site(3);
    s.bus.cutOff(1);
    await s.run(LEASE_MS * 4);
    const [winner] = s.hosts();
    s.bus.reconnect(1);
    await s.run(HEARTBEAT_MS * 3);
    expect(s.pcs[0]!.host).toBe(false);
    expect(s.pcs[0]!.following).toBe(winner);
    expect(s.hosts()).toEqual([winner]);
  });

  it('a minority cut off from the rest cannot elect (no split brain)', async () => {
    const s = site(5);
    // Host 1 and PC 2 end up on one side, 3–5 on the other: only the side with 3 of 5 votes elects.
    s.bus.cutOff(1);
    s.bus.cutOff(2);
    await s.run(LEASE_MS * 5);
    const majority = s.hosts();
    expect(majority).toHaveLength(1);
    expect([3, 4, 5]).toContain(majority[0]);
    expect(s.pcs[1]!.host).toBe(false); // PC 2 alone never became host
    expect(s.pcs[1]!.becameHostAt).toEqual([]);
  });

  it('a 2-PC site never elects by itself (D3: its secondary waits; an admin can take over)', async () => {
    const s = site(2);
    s.bus.cutOff(1);
    await s.run(LEASE_MS * 5);
    expect(s.pcs[1]!.host).toBe(false);
    expect(s.pcs[1]!.term).toBe(1);
  });

  it('a non-voting PC (a laptop that comes and goes) neither votes nor counts towards the majority', async () => {
    // 3 PCs but one doesn't vote: a 2-voter site does not elect.
    const s = site(3, { voting: (no) => no !== 3 });
    s.bus.cutOff(1);
    await s.run(LEASE_MS * 5);
    expect(s.hosts()).toEqual([]);
  });

  it('voters never elect a PC that is behind them in the host\'s stream', async () => {
    // PC 2 missed the last updates; PC 3 and PC 4 are caught up: PC 2 can't win.
    const s = site(4, { seq: (no) => (no === 2 ? 5 : 10) });
    s.bus.cutOff(1);
    await s.run(LEASE_MS * 5);
    const [winner] = s.hosts();
    expect([3, 4]).toContain(winner);
  });

  it('one vote per term', async () => {
    const s = site(3);
    const pc = s.pcs[2]!;
    const sent: ElectionMsg[] = [];
    s.bus.for(99).onMessage((m) => sent.push(m));
    await pc.election!.onMessage({ t: 'ask', site: 1, term: 5, from: 1, progress: { epoch: 'e1', seq: 10, version: '1.0.0' } });
    await pc.election!.onMessage({ t: 'ask', site: 1, term: 5, from: 2, progress: { epoch: 'e1', seq: 10, version: '1.0.0' } });
    await new Promise((r) => setTimeout(r, 0));
    const votes = sent.filter((m): m is Extract<ElectionMsg, { t: 'vote' }> => m.t === 'vote');
    expect(votes.map((v) => [v.to, v.granted])).toEqual([[1, true], [2, false]]);
  });
});

describe('helpers', () => {
  it('compares versions and progress', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
    const mine = { epoch: 'e1', seq: 10, version: '1.2.0' };
    expect(atLeastAsCaughtUp({ epoch: 'e1', seq: 10, version: '1.2.0' }, mine)).toBe(true);
    expect(atLeastAsCaughtUp({ epoch: 'e1', seq: 9, version: '1.2.0' }, mine)).toBe(false);
    expect(atLeastAsCaughtUp({ epoch: 'e1', seq: 11, version: '1.1.9' }, mine)).toBe(false);
  });

  it('the LAN bus delivers signed messages and drops forgeries', async () => {
    const port = 40000 + Math.floor(Math.random() * 2000);
    const a = udpBus({ siteKey: 'site-ca-key', peers: () => ['127.0.0.1'], port });
    const got: ElectionMsg[] = [];
    a.onMessage((m) => got.push(m));
    const forger = udpBus({ siteKey: 'someone-else', peers: () => ['127.0.0.1'], port: port + 1 });
    await new Promise((r) => setTimeout(r, 100));
    const hb: ElectionMsg = { t: 'hb', site: 1, term: 2, from: 3, url: null, tenant: null };
    a.send(hb);
    // The forger sends to the same port with a different key.
    const dgram = await import('node:dgram');
    const raw = dgram.createSocket('udp4');
    raw.send(Buffer.from(JSON.stringify({ body: JSON.stringify({ at: Date.now(), msg: { ...hb, from: 666 } }), sig: 'f'.repeat(64) })), port, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 300));
    raw.close();
    a.close();
    forger.close();
    expect(got.some((m) => m.t === 'hb' && m.from === 3)).toBe(true);
    expect(got.some((m) => m.from === 666)).toBe(false);
  });
});
