/**
 * Run the automatic host election (election.ts) on an installed PC: the election's view of this
 * PC and its site comes from the sync tables, and winning or losing uses phase 5a's take-over /
 * step-down / follow (failover.ts). docs/OFFLINE-FIRST.md §31.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getDb } from '../shared/db';
import { syncConfigOf } from './node';
import { APP_VERSION } from './commands';
import { siteOfThisPc } from './sites';
import { nodeState, stepDown, switchHost, takeOverAsHost } from './failover';
import { SiteElection, udpBus, type ElectionBus, type ElectionDeps } from './election';
import { exportSiteAuthority } from '../desktop/lan-tls';

/** The election's view of PC `slug`. Null when it isn't a PC of a site. */
export function electionDeps(slug: string, clock: { now(): number; random(): number } = { now: Date.now, random: Math.random }): ElectionDeps | null {
  const conn = () => getDb(slug);
  const cfg0 = syncConfigOf(conn());
  if (cfg0?.role !== 'node') return null;
  const site = siteOfThisPc(conn(), cfg0);
  if (site == null) return null;
  const self = cfg0.nodeNo;
  const isHost = () => syncConfigOf(conn())?.isHost === true;
  const voting = (c: DatabaseSync) => (c.prepare('SELECT voting FROM sync_node WHERE k = 1').get() as { voting: number }).voting === 1;
  return {
    self, site,
    voters: () => {
      const c = conn();
      const others = (c.prepare('SELECT node_no FROM sync_nodes WHERE revoked_at IS NULL AND voting = 1 AND node_no != ?').all(self) as
        Array<{ node_no: number }>).map((r) => r.node_no);
      return voting(c) ? [self, ...others] : others;
    },
    isHost,
    currentHost: () => {
      if (isHost()) return null;
      const url = (conn().prepare('SELECT cloud_url FROM sync_remote WHERE k = 1').get() as { cloud_url: string } | undefined)?.cloud_url;
      const row = url ? conn().prepare('SELECT node_no FROM sync_nodes WHERE lan_url = ?').get(url) as { node_no: number } | undefined : undefined;
      return row?.node_no ?? null;
    },
    term: () => nodeState(conn()).site_term,
    setTerm: (t) => { conn().prepare('UPDATE sync_node SET site_term = MAX(site_term, ?) WHERE k = 1').run(t); },
    votedFor: (t) => {
      const r = conn().prepare('SELECT voted_term, voted_for FROM sync_node WHERE k = 1').get() as { voted_term: number | null; voted_for: number | null };
      return r.voted_term === t ? r.voted_for : null;
    },
    recordVote: (t, cand) => { conn().prepare('UPDATE sync_node SET voted_term = ?, voted_for = ? WHERE k = 1').run(t, cand); },
    progress: () => {
      const c = conn();
      const st = nodeState(c);
      return isHost()
        ? { epoch: st.stream_epoch, seq: (c.prepare('SELECT COALESCE(MAX(authority_seq), 0) AS s FROM sync_effects').get() as { s: number }).s, version: APP_VERSION }
        : { epoch: st.host_epoch, seq: (c.prepare('SELECT last_authority_seq AS s FROM sync_node WHERE k = 1').get() as { s: number }).s, version: APP_VERSION };
    },
    address: () => { const st = nodeState(conn()); return { url: st.lan_url, tenant: st.lan_tenant }; },
    becomeHost: async (term) => {
      console.log(`[election] this PC won the election for site ${site} (term ${term}); taking over as host`);
      await takeOverAsHost(slug, { term });
    },
    follow: (hb) => {
      const c = conn();
      const cfg = syncConfigOf(c)!;
      if (!hb.url) return;
      if (cfg.isHost) {
        console.log(`[election] PC #${hb.from} hosts site ${site} under term ${hb.term}; stepping down`);
        stepDown(c, cfg, { site_no: site, host: hb.from, term: hb.term, host_lan_url: hb.url, host_lan_tenant: hb.tenant });
      } else {
        console.log(`[election] following PC #${hb.from}, host of site ${site} under term ${hb.term}`);
        switchHost(c, { url: hb.url, tenant: hb.tenant, term: hb.term });
      }
    },
    now: clock.now,
    random: clock.random,
  };
}

/**
 * Start the election on the installed app's PC (once it belongs to a site and holds the site's
 * certificate authority, which keys the LAN messages). It only ever acts at sites with 3+ voting
 * PCs; otherwise it just stays quiet. Returns a stop function.
 */
export function startSiteElection(slug: string, opts: { bus?: ElectionBus; tickMs?: number } = {}): () => void {
  let election: SiteElection | null = null;
  let bus: (ElectionBus & { close?: () => void }) | null = opts.bus ?? null;
  const tick = async () => {
    try {
      if (!election) {
        const deps = electionDeps(slug);
        if (!deps) return; // not (yet) a PC of a site
        if (!bus) {
          const dir = process.env.LAN_TLS_DIR;
          const ca = dir && fs.existsSync(path.join(dir, 'ca.key')) ? exportSiteAuthority(dir) : null;
          if (!ca) return; // the site's authority arrives with the first round through the host
          bus = udpBus({
            siteKey: ca.key,
            peers: () => (getDb(slug).prepare('SELECT lan_url FROM sync_nodes WHERE lan_url IS NOT NULL').all() as Array<{ lan_url: string }>)
              .map((r) => { try { return new URL(r.lan_url).hostname; } catch { return ''; } }).filter(Boolean),
          });
        }
        election = new SiteElection(deps, bus);
      }
      await election.tick();
    } catch (e) {
      console.warn('[election]', (e as Error).message);
    }
  };
  const timer = setInterval(() => { void tick(); }, opts.tickMs ?? 500);
  timer.unref();
  return () => {
    clearInterval(timer);
    election?.stop();
    if (!opts.bus) bus?.close?.();
  };
}
