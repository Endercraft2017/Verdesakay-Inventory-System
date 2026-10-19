/**
 * "Talk to us" sales inquiries from the public website (docs/SAAS-READINESS.md §12). A company
 * fills in the website form instead of signing itself up; the owner sees it in the console,
 * follows up, and creates the workspace from it. Kept in the control plane (`platform.db`) with
 * the contact details the website shows beside the form.
 */
import type { DatabaseSync } from 'node:sqlite';
import { platformDb } from './platform';
import { MODULES } from '../shared/modules';

export type InquiryStatus = 'new' | 'contacted' | 'won' | 'lost';
export const INQUIRY_STATUSES: InquiryStatus[] = ['new', 'contacted', 'won', 'lost'];

export interface InquiryRow {
  id: number;
  name: string;
  company: string;
  email: string;
  phone: string | null;
  employees: string | null;
  modules: string | null; // JSON array of module names they're interested in
  message: string | null;
  status: InquiryStatus;
  notes: string | null;
  tenant_slug: string | null;
  created_at: string;
  updated_at: string;
}

const ready = new WeakSet<DatabaseSync>();
function db(): DatabaseSync {
  const d = platformDb();
  if (ready.has(d)) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      company     TEXT NOT NULL,
      email       TEXT NOT NULL,
      phone       TEXT,
      employees   TEXT,
      modules     TEXT,
      message     TEXT,
      status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','won','lost')),
      notes       TEXT,
      tenant_slug TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS inquiries_status ON inquiries (status, id);
    CREATE TABLE IF NOT EXISTS site_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  ready.add(d);
  return d;
}

export interface NewInquiry {
  name: string; company: string; email: string; phone?: string | null;
  employees?: string | null; modules?: string[]; message?: string | null;
}

export function createInquiry(input: NewInquiry, setup?: (inquiry: InquiryRow) => undefined): InquiryRow {
  const d = db(); // Initialize schema before the rollbackable transaction.
  d.exec('SAVEPOINT create_inquiry');
  try {
    const mods = (input.modules || []).filter((m) => (MODULES as readonly string[]).includes(m));
    const info = db().prepare(
      `INSERT INTO inquiries (name, company, email, phone, employees, modules, message) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(input.name, input.company, input.email, input.phone || null, input.employees || null,
      mods.length ? JSON.stringify(mods) : null, input.message || null);
    const row = getInquiry(Number(info.lastInsertRowid))!;
    setup?.(row);
    d.exec('RELEASE create_inquiry');
    return row;
  } catch (error) { d.exec('ROLLBACK TO create_inquiry'); d.exec('RELEASE create_inquiry'); throw error; }
}

export function getInquiry(id: number): InquiryRow | null {
  return (db().prepare('SELECT * FROM inquiries WHERE id = ?').get(id) as unknown as InquiryRow | undefined) ?? null;
}

export function listInquiries(status?: string): InquiryRow[] {
  return (status
    ? db().prepare('SELECT * FROM inquiries WHERE status = ? ORDER BY id DESC').all(status)
    : db().prepare('SELECT * FROM inquiries ORDER BY id DESC').all()) as unknown as InquiryRow[];
}

export function countNewInquiries(): number {
  return (db().prepare("SELECT COUNT(*) AS c FROM inquiries WHERE status = 'new'").get() as { c: number }).c;
}

export function updateInquiry(id: number, patch: { status?: InquiryStatus; notes?: string | null; tenant_slug?: string | null }): InquiryRow | null {
  const cur = getInquiry(id);
  if (!cur) return null;
  db().prepare(`UPDATE inquiries SET status = ?, notes = ?, tenant_slug = ?, updated_at = datetime('now') WHERE id = ?`).run(
    patch.status ?? cur.status,
    'notes' in patch ? (patch.notes?.trim() || null) : cur.notes,
    'tenant_slug' in patch ? (patch.tenant_slug || null) : cur.tenant_slug,
    id,
  );
  return getInquiry(id);
}

export function inquiryView(r: InquiryRow) {
  let modules: string[] = [];
  try { modules = r.modules ? JSON.parse(r.modules) : []; } catch { modules = []; }
  return { ...r, modules };
}

/* ---------------- contact details shown on the website ---------------- */

export interface SiteContact { email: string; phone: string; messenger: string }
const CONTACT_KEYS: Array<keyof SiteContact> = ['email', 'phone', 'messenger'];

export function getSiteContact(): SiteContact {
  const out: SiteContact = { email: '', phone: '', messenger: '' };
  const rows = db().prepare("SELECT key, value FROM site_settings WHERE key LIKE 'contact_%'").all() as unknown as Array<{ key: string; value: string }>;
  for (const r of rows) {
    const k = r.key.slice('contact_'.length) as keyof SiteContact;
    if (CONTACT_KEYS.includes(k)) out[k] = r.value;
  }
  return out;
}

export function setSiteContact(patch: Partial<SiteContact>): SiteContact {
  const put = db().prepare('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of CONTACT_KEYS) if (typeof patch[k] === 'string') put.run(`contact_${k}`, patch[k]!.trim());
  return getSiteContact();
}
