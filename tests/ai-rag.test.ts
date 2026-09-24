/** RAG knowledge search (FTS5): indexing, BM25 retrieval, per-chunk ACL
    filtering, the search_knowledge tool, and the admin reindex endpoint. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, addSerializedUnits, type TestContext } from './helpers';
import { ALL_PERMISSIONS } from '../src/shared/permissions';
import type { AuthUser, Permission } from '../src/shared/types';

let ctx: TestContext;
let token: string;
let rag: typeof import('../src/modules/ai/rag');
let air: typeof import('../src/modules/ai/ai-rag');

const authHdr = () => ({ Authorization: `Bearer ${token}` });
const mkUser = (perms: Permission[]): AuthUser => ({
  id: 1, username: 'u', full_name: 'U', role: 'admin',
  department_id: null, active: 1, department_name: null, permissions: perms,
});
const admin = () => mkUser([...ALL_PERMISSIONS]);

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
  rag = await import('../src/modules/ai/rag');
  air = await import('../src/modules/ai/ai-rag');

  // Distinctive unstructured text across a few sources.
  await ctx.api.post('/api/inventory').set(authHdr())
    .send({ name: 'Flux Capacitor', sku: 'FLX-1', notes: 'The flux capacitor requires recalibration every 88 hours or temporal drift occurs.' });

  const pid = (await ctx.api.post('/api/inventory').set(authHdr()).send({ name: 'RAG Prod' })).body.id;
  const cid = (await ctx.api.post('/api/inventory').set(authHdr()).send({ name: 'RAG Part', quantity: 50 })).body.id;
  await ctx.api.put(`/api/finished-products/${pid}`).set(authHdr()).send({ components: [{ component_item_id: cid, quantity: 1 }] });
  const mo = (await ctx.api.post('/api/job-orders').set(authHdr()).send({ product_item_id: pid, qty_ordered: 1, qc_stages: 1 })).body.id;
  await ctx.api.post(`/api/job-orders/${mo}/release`).set(authHdr());
  await ctx.api.post(`/api/job-orders/${mo}/accept`).set(authHdr());
  await addSerializedUnits(ctx.api, token, mo, 1, 'RAG');
  const unit = (await ctx.api.get(`/api/job-orders/${mo}/units`).set(authHdr())).body[0].id;
  await ctx.api.post(`/api/job-orders/${mo}/units/inspect`).set(authHdr())
    .send({ unit_ids: [unit], result: 'fail', disposition: 'scrap', remarks: 'Recurring gasket seal leak on the left intake manifold.' });

  await ctx.api.post('/api/forms').set(authHdr())
    .field('title', 'Overtime Policy')
    .field('category', 'HR')
    .attach('file', Buffer.from('Employees may claim overtime for weekend work only with prior written supervisor approval.'), 'ot-policy.txt');
});
afterAll(() => cleanup(ctx));

describe('rag: indexing + retrieval', () => {
  it('reindex builds a non-empty index including the app docs', () => {
    const n = rag.reindex();
    expect(n).toBeGreaterThan(5); // KB files alone chunk into several rows
  });

  it('retrieves the right passage per query', () => {
    const cap = rag.retrieve('flux capacitor recalibration temporal drift', admin());
    expect(cap[0]?.ref).toMatch(/Flux Capacitor/);

    const qc = rag.retrieve('gasket seal leak manifold', admin());
    expect(qc.some((r) => r.source_type === 'qc_remark')).toBe(true);

    const ot = rag.retrieve('overtime weekend supervisor approval', admin());
    expect(ot.some((r) => r.source_type === 'form')).toBe(true);
  });

  it('filters by source_types', () => {
    const only = rag.retrieve('recalibration OR gasket OR manifold', admin(), { source_types: ['qc_remark'] });
    expect(only.every((r) => r.source_type === 'qc_remark')).toBe(true);
    expect(only.some((r) => r.source_type === 'item_note')).toBe(false);
  });

  it('hides passages the caller has no permission for', () => {
    const limited = mkUser(['messages.view']); // no inventory.view / forms.view
    const cap = rag.retrieve('flux capacitor recalibration', limited);
    expect(cap.some((r) => r.source_type === 'item_note')).toBe(false);
    const ot = rag.retrieve('overtime weekend approval', limited);
    expect(ot.some((r) => r.source_type === 'form')).toBe(false);
    // public KB is still visible
    const kb = rag.retrieve('inventory system office', limited);
    expect(kb.some((r) => r.source_type === 'kb')).toBe(true);
  });

  it('returns nothing for an empty / stopword-only query', () => {
    expect(rag.retrieve('  a  ', admin())).toEqual([]);
  });
});

describe('rag: search_knowledge tool', () => {
  it('wraps retrieval with a helpful note', () => {
    const hit = air.executeRagTool('search_knowledge', { query: 'gasket manifold leak' }, admin());
    expect(hit.success).toBe(true);
    expect((hit.data as { results: unknown[] }).results.length).toBeGreaterThan(0);

    const miss = air.executeRagTool('search_knowledge', { query: 'zzxqq wvbqz kxplf qqzzx' }, admin());
    expect((miss.data as { results: unknown[]; note: string }).results.length).toBe(0);
    expect((miss.data as { note: string }).note).toMatch(/No matching/i);
  });

  it('rejects an empty query', () => {
    expect(air.executeRagTool('search_knowledge', { query: '' }, admin()).success).toBe(false);
  });
});

describe('rag: POST /api/ai/reindex', () => {
  it('is admin-gated', async () => {
    const ok = await ctx.api.post('/api/ai/reindex').set(authHdr());
    expect(ok.status).toBe(200);
    expect(ok.body.chunks).toBeGreaterThan(0);

    expect((await ctx.api.post('/api/ai/reindex')).status).toBe(401);
  });
});
