/** Rehearse a v97-shaped database upgrade, never the checkout's operational DB. */
import {it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setupApp,cleanup,login} from './helpers';

it('upgrades a legacy database copy twice while preserving IDs, snapshots, source records and financial totals',async()=>{
  const ctx=await setupApp();
  try {
    const token=await login(ctx.api),hdr={Authorization:`Bearer ${token}`};
    expect((await ctx.api.post('/api/accounting/ledger/setup').set(hdr).send({fiscal_year_start:'2026-01-01'})).status).toBe(201);
    const c=await ctx.api.post('/api/customers').set(hdr).send({name:'Synthetic legacy buyer',phone:'+63 (912) 345-6789',email:' BUYER@EXAMPLE.TEST ',address:'Original delivery address'});
    const so=await ctx.api.post('/api/orders').set(hdr).send({type:'sale',customer_id:c.body.id,status:'confirmed',order_date:'2026-10-01',items:[{name:'Synthetic legacy sale',quantity:2,unit_price:100}],tax_percent:12});
    expect(so.status).toBe(201);
    const {activeDb,getDb,forceMigrate}=await import('../src/shared/db');
    const dir=process.env.DATA_DIR!;fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,'csr-legacy.db');activeDb().prepare('VACUUM INTO ?').run(file);
    const raw=new DatabaseSync(file);
    // Remove exactly this release's additions to reconstruct the preceding schema shape.
    raw.exec(`DROP TRIGGER protect_case_sale_customer; DROP TRIGGER protect_customer_history;
      DROP TRIGGER protect_case_events_update; DROP TRIGGER protect_case_events_delete;
      DROP TABLE customer_case_events; DROP TABLE customer_cases;
      DROP INDEX idx_orders_creation_key; DROP INDEX idx_customers_phone; DROP INDEX idx_customers_email;`);
    for(const col of ['facebook_name','facebook_url','phone_normalized','email_normalized','version'])raw.exec('ALTER TABLE customers DROP COLUMN '+col);
    for(const col of ['creation_key','creation_hash'])raw.exec('ALTER TABLE orders DROP COLUMN '+col);
    raw.exec("UPDATE settings SET value='97' WHERE key='schema_version'");
    // Deliberately ambiguous legacy names survive; migration must never merge by name.
    raw.prepare("INSERT INTO customers(name,phone) VALUES ('Synthetic legacy buyer','09123456789')").run();
    const tables=['customers','orders','order_items','journal_entries','journal_lines','payments','credit_notes','form_definitions','form_records'];
    const before=new Map(tables.map(t=>[t,{cols:raw.prepare('PRAGMA table_info('+t+')').all().map(c=>String(c.name)),rows:raw.prepare('SELECT * FROM '+t+' ORDER BY id').all()}]));
    const journalCount=raw.prepare('SELECT count(*) AS n FROM journal_entries').get()!.n;
    expect(Number(journalCount)).toBeGreaterThan(0);
    raw.close();
    const upgraded=getDb('csr-legacy');
    const reconcile=()=>{
      for(const [t,b] of before)expect(upgraded.prepare('SELECT '+b.cols.join(',')+' FROM '+t+' ORDER BY id').all(),t).toEqual(b.rows);
      expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(upgraded.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
      expect(upgraded.prepare('SELECT count(*) AS n FROM customer_cases').get()!.n).toBe(0);
      expect(upgraded.prepare('SELECT count(*) AS n FROM customer_case_events').get()!.n).toBe(0);
      expect(upgraded.prepare('SELECT phone_normalized,email_normalized FROM customers WHERE id=?').get(c.body.id)).toMatchObject({phone_normalized:'09123456789',email_normalized:'buyer@example.test'});
    };
    reconcile();forceMigrate('csr-legacy');reconcile();
    const {backupDir}=await import('../src/shared/backup');
    expect(fs.readdirSync(path.join(backupDir(),'csr-legacy','pre-migrate')).some(f=>f.endsWith('.db'))).toBe(true);
    expect(upgraded.prepare("SELECT value FROM settings WHERE key='schema_version'").get()!.value).toBe('98');
  } finally {cleanup(ctx);}
});
