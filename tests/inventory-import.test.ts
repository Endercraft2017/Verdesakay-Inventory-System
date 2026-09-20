/** CSV import / export for inventory items: upsert-by-SKU, initial stock on create,
    per-row error reporting, dry-run, name/department/supplier resolution, round-trip. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { parseCsvTable, toCsv } from '../src/shared/csv';

let ctx: TestContext;
let token: string;
const authHdr = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ctx = await setupApp();
  token = await login(ctx.api);
});
afterAll(() => cleanup(ctx));

const imp = (csv: string, dry_run = false) =>
  ctx.api.post('/api/inventory/import').set(authHdr()).send({ csv, dry_run });

interface ItemRow { id: number; sku: string | null; name: string; quantity: number; }
const findBySku = async (sku: string): Promise<ItemRow | undefined> => {
  const res = await ctx.api.get(`/api/inventory?q=${encodeURIComponent(sku)}`).set(authHdr());
  return (res.body as ItemRow[]).find((i) => i.sku === sku);
};

describe('csv helpers', () => {
  it('parses a header table and round-trips through toCsv', () => {
    const t = parseCsvTable('Name,SKU,Notes\r\n"Widget, big",W-1,"line1\nline2"\n');
    expect(t.headers).toEqual(['Name', 'SKU', 'Notes']);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ name: 'Widget, big', sku: 'W-1', notes: 'line1\nline2' });

    const back = toCsv(['name', 'sku'], [{ name: 'a,b', sku: 'x"y' }]);
    expect(parseCsvTable(back).rows[0]).toMatchObject({ name: 'a,b', sku: 'x"y' });
  });

  it('skips fully blank lines', () => {
    expect(parseCsvTable('name\n\nA\n\n').rows.map((r) => r.name)).toEqual(['A']);
  });
});

describe('POST /api/inventory/import', () => {
  it('creates new items, applies initial stock, and reports counts', async () => {
    const r = await imp(
      'name,sku,quantity,min_quantity,unit\n' +
      'Hex Bolt M8,HB-M8,500,100,pcs\n' +
      'Lock Washer,LW-8,,50,pcs\n'
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 2, updated: 0, skipped: 0, total: 2, dry_run: false });

    const bolt = await findBySku('HB-M8');
    expect(bolt!.quantity).toBe(500);

    const detail = await ctx.api.get(`/api/inventory/${bolt!.id}`).set(authHdr());
    expect(detail.body.history.at(-1).reason).toBe('Import: initial stock');
  });

  it('updates an existing item by SKU without touching its quantity', async () => {
    await imp('name,sku,quantity\nOld Name,UP-1,30\n');
    const r = await imp('name,sku,quantity,notes\nNew Name,UP-1,999,"changed via import"\n');
    expect(r.body).toMatchObject({ created: 0, updated: 1 });

    const item = await findBySku('UP-1');
    expect(item!.name).toBe('New Name');
    expect(item!.quantity).toBe(30); // unchanged — import never moves stock on existing items
  });

  it('resolves department and supplier by name, and errors on unknown ones', async () => {
    // Seeded department "Operations" exists; create a supplier to match.
    await ctx.api.post('/api/suppliers').set(authHdr()).send({ name: 'Acme Fasteners' });

    const ok = await imp('name,sku,department,supplier\nAnchor Bolt,AB-1,Operations,Acme Fasteners\n');
    expect(ok.body).toMatchObject({ created: 1, skipped: 0 });
    const item = await findBySku('AB-1');
    const detail = await ctx.api.get(`/api/inventory/${item!.id}`).set(authHdr());
    expect(detail.body.department_name).toBe('Operations');
    expect(detail.body.supplier_name).toBe('Acme Fasteners');

    const bad = await imp('name,sku,department\nGhost Item,GH-1,Nonexistent Dept\n');
    expect(bad.body).toMatchObject({ created: 0, skipped: 1 });
    expect(bad.body.errors[0].message).toMatch(/unknown department/i);
  });

  it('skips invalid rows without aborting the batch', async () => {
    const r = await imp(
      'name,sku,min_quantity\n' +
      ',NO-NAME,5\n' +               // missing name -> error
      'Good Row,GR-1,5\n' +          // ok
      'Bad Min,BM-1,notanumber\n'    // bad number -> error
    );
    expect(r.body.created).toBe(1);
    expect(r.body.skipped).toBe(2);
    expect(r.body.errors.map((e: { row: number }) => e.row).sort()).toEqual([1, 3]);
  });

  it('dry_run validates but writes nothing', async () => {
    const r = await imp('name,sku,quantity\nPhantom,PH-DRY,10\n', true);
    expect(r.body).toMatchObject({ dry_run: true, created: 1 });
    expect(await findBySku('PH-DRY')).toBeUndefined();
  });

  it('rejects a CSV with no name column', async () => {
    const r = await imp('sku,quantity\nX-1,5\n');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/name/i);
  });

  it('requires inventory.create permission', async () => {
    const viewer = await createEmployee(ctx.api, token, { role: 'marketing' }); // inventory.view only
    const r = await ctx.api
      .post('/api/inventory/import')
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({ csv: 'name,sku\nNope,N-1\n' });
    expect(r.status).toBe(403);
  });
});

describe('GET /api/inventory/export', () => {
  it('round-trips: export then re-import is all updates, no creates', async () => {
    await imp('name,sku,quantity,min_quantity\nRound Trip A,RT-A,12,3\nRound Trip B,RT-B,0,1\n');

    const exp = await ctx.api.get('/api/inventory/export').set(authHdr());
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toMatch(/text\/csv/);
    const table = parseCsvTable(exp.text);
    expect(table.headers).toContain('sku');
    expect(table.rows.some((r) => r.sku === 'RT-A')).toBe(true);

    const back = await imp(exp.text);
    expect(back.body.created).toBe(0);
    expect(back.body.updated).toBeGreaterThanOrEqual(2);
    expect(back.body.skipped).toBe(0);
  });
});
