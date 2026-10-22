import {canRecordJob,scopedLineReader} from '../manufacturing/job-access';
import { canOnOrder } from '../inventory/order-access';
import { moduleEnabled } from '../../shared/modules';
import { JOB_ORDER_DETAIL } from '../../shared/desk-access';
/**
 * Knowledge retrieval (RAG) for the AI agent, built on SQLite FTS5 (BM25).
 *
 * `reindex()` rebuilds the `doc_chunks` full-text index from the unstructured
 * text in the database — uploaded files, notes, QC remarks, form details, and
 * the markdown docs. Every chunk carries an ACL (a permission key) and optional
 * `dept_id`; `retrieve()` runs the FTS query then filters to what the caller may
 * see. Indexing is lazy: `retrieve()` rebuilds if the index is older than 5 min.
 */
import fs from 'node:fs';
import { resolveDurableUpload } from '../../shared/durable-uploads';
// Plain-text uploads the index reads; the file bucket keeps exactly these on disk.
import { TEXT_EXT } from '../../shared/file-store';
import path from 'node:path';
import { db, run, queryAll, queryOne, getSetting, setSetting } from '../../shared/db';
import type { AuthUser } from '../../shared/types';
import { PAYROLL_FORM_SLUG } from '../payroll/pay-access';

const STALE_MS = 5 * 60 * 1000;
const KB_FILES = [
  'README.md', 'docs/README.md', 'docs/DECISIONS.md', 'docs/AI-AGENT.md', 'docs/ARCHITECTURE.md',
  'docs/guides/production-sop.md',
];

interface ChunkRow {
  body: string; ref_label: string; source_type: string; source_id: string;
  acl: string; dept_id: number | null;
}

/** Split long text into ~900-char windows, preferring sentence / paragraph breaks. */
function chunk(text: string, size = 900): string[] {
  const t = String(text ?? '').replace(/[ \t]+\n/g, '\n').trim();
  if (!t) return [];
  if (t.length <= size) return [t];
  const out: string[] = [];
  let i = 0;
  while (i < t.length) {
    let end = Math.min(t.length, i + size);
    if (end < t.length) {
      const w = t.slice(i, end);
      const br = Math.max(w.lastIndexOf('\n\n'), w.lastIndexOf('. '), w.lastIndexOf('\n'));
      if (br > size * 0.5) end = i + br + 1;
    }
    const piece = t.slice(i, end).trim();
    if (piece) out.push(piece);
    i = end;
  }
  return out;
}

function push(rows: ChunkRow[], base: Omit<ChunkRow, 'body'>, text: string): void {
  for (const c of chunk(text)) rows.push({ ...base, body: c });
}

/** Rebuild the whole full-text index. Returns the chunk count. */
export function reindex(): number {
  const rows: ChunkRow[] = [];
  const safe = (fn: () => void) => { try { fn(); } catch { /* skip a source that isn't present */ } };

  safe(() => {
    for (const rel of KB_FILES) {
      const p = path.join(import.meta.dirname, '..', '..', '..', rel);
      if (!fs.existsSync(p)) continue;
      push(rows, { ref_label: `Docs · ${path.basename(rel)}`, source_type: 'kb', source_id: rel, acl: 'public', dept_id: null },
        fs.readFileSync(p, 'utf8'));
    }
  });

  safe(() => {
    for (const f of queryAll<{ id: number; title: string; description: string | null; category: string | null; original_name: string; stored_name: string; department_id: number | null }>(
      'SELECT id, title, description, category, original_name, stored_name, department_id FROM forms'
    )) {
      let body = [f.title, f.category, f.description, f.original_name].filter(Boolean).join('\n');
      const ext = path.extname(f.original_name || '').toLowerCase();
      if (TEXT_EXT.has(ext)) {
        try { const file = resolveDurableUpload(f.stored_name); if (file) body += '\n' + fs.readFileSync(file, 'utf8').slice(0, 20000); } catch { /* unreadable */ }
      }
      push(rows, { ref_label: `File · ${f.title || f.original_name}`, source_type: 'form', source_id: String(f.id), acl: 'forms.view', dept_id: f.department_id ?? null }, body);
    }
  });

  safe(() => {
    for (const it of queryAll<{ id: number; name: string; sku: string | null; notes: string }>(
      "SELECT id, name, sku, notes FROM inventory_items WHERE notes IS NOT NULL AND TRIM(notes) <> ''"
    )) {
      push(rows, { ref_label: `Item · ${it.name}${it.sku ? ` (${it.sku})` : ''}`, source_type: 'item_note', source_id: String(it.id), acl: 'inventory.view', dept_id: null }, it.notes);
    }
  });

  safe(() => {
    for (const q of queryAll<{ id: number; result: string; remarks: string; number: string | null }>(
      "SELECT q.id, q.result, q.remarks, j.number FROM qc_records q LEFT JOIN job_orders j ON j.id = q.job_order_id WHERE q.remarks IS NOT NULL AND TRIM(q.remarks) <> ''"
    )) {
      rows.push({ body: `QC ${q.result}: ${q.remarks}`, ref_label: `QC · ${q.number || 'MO'} (${q.result})`, source_type: 'qc_remark', source_id: String(q.id), acl: 'production.view', dept_id: null });
    }
  });

  safe(() => {
    for (const o of queryAll<{ id: number; number: string; notes: string }>(
      "SELECT id, number, notes FROM orders WHERE notes IS NOT NULL AND TRIM(notes) <> ''"
    )) {
      push(rows, { ref_label: `Order · ${o.number}`, source_type: 'order_note', source_id: String(o.id), acl: 'orders.view', dept_id: null }, o.notes);
    }
  });

  safe(() => {
    for (const j of queryAll<{ id: number; number: string; notes: string }>(
      "SELECT id, number, notes FROM job_orders WHERE notes IS NOT NULL AND TRIM(notes) <> ''"
    )) {
      push(rows, { ref_label: `Job order · ${j.number}`, source_type: 'job_order_note', source_id: String(j.id), acl: 'production.view', dept_id: null }, j.notes);
    }
  });

  safe(() => {
    for (const fr of queryAll<{ id: number; number: string; data: string; form_name: string; slug: string; scope: string | null }>(
      'SELECT fr.id, fr.number, fr.data, fd.name AS form_name, fd.slug, fd.scope FROM form_records fr JOIN form_definitions fd ON fd.id = fr.form_def_id'
    )) {
      let flat = '';
      try {
        const d = JSON.parse(fr.data || '{}') as Record<string, unknown>;
        flat = Object.entries(d).map(([k, v]) => `${k}: ${v}`).join('; ');
      } catch { /* not JSON */ }
      if (!flat.trim()) continue;
      // Same reader as the record itself: payslips payroll.view, a section's records its
      // forms.manage.<scope> (General needs admin) — not forms.view, which nearly everyone holds.
      const acl = fr.slug === PAYROLL_FORM_SLUG ? 'payroll.view' : fr.scope ? `forms.manage.${fr.scope}` : 'users.manage';
      rows.push({ body: `${fr.form_name} ${fr.number}\n${flat}`, ref_label: `${fr.form_name} · ${fr.number}`, source_type: 'form_record', source_id: String(fr.id), acl, dept_id: null });
    }
  });

  safe(() => {
    for (const ed of queryAll<{ id: number; title: string; emp: string | null }>(
      'SELECT ed.id, ed.title, e.name AS emp FROM employee_documents ed LEFT JOIN employees e ON e.id = ed.employee_id'
    )) {
      rows.push({ body: `${ed.title} (${ed.emp || 'employee'})`, ref_label: `HR doc · ${ed.title}`, source_type: 'employee_doc', source_id: String(ed.id), acl: 'hr.view', dept_id: null });
    }
  });

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM doc_chunks');
    for (const r of rows) {
      run('INSERT INTO doc_chunks (body, ref_label, source_type, source_id, acl, dept_id) VALUES (?, ?, ?, ?, ?, ?)',
        r.body, r.ref_label, r.source_type, r.source_id, r.acl, r.dept_id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  setSetting('rag_indexed_at', Date.now());
  return rows.length;
}

/** Rebuild if forced or stale; otherwise return the current chunk count. */
export function maybeReindex(force = false): number {
  const last = getSetting<number>('rag_indexed_at') || 0;
  if (force || Date.now() - last > STALE_MS) return reindex();
  return queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM doc_chunks')?.n ?? 0;
}

/** Check the current source row, not stale cached ACLs or departments. */
function canSee(r: { source_type: string; source_id: string; acl: string; dept_id: unknown }, user: AuthUser): boolean {
  const has = (p: string) => user.permissions.includes(p as never);
  const id = Number(r.source_id);
  switch (r.source_type) {
    case 'kb': return true;
    case 'form': {
      if (!has('forms.view')) return false;
      const row = queryOne<{department_id:number|null}>('SELECT department_id FROM forms WHERE id=?',id);
      return !!row && (row.department_id == null || row.department_id === user.department_id || has('users.permissions'));
    }
    case 'item_note': return moduleEnabled('inventory') && has('inventory.view') && !!queryOne('SELECT 1 FROM inventory_items WHERE id=?',id);
    case 'order_note': {
      const row=queryOne<{type:string}>('SELECT type FROM orders WHERE id=?',id);
      return !!row && canOnOrder(user,row.type,'view');
    }
    case 'job_order_note': if(scopedLineReader(user) && !canRecordJob(user,id)) return false; return moduleEnabled('manufacturing') && (has('production.view') || JOB_ORDER_DETAIL.some(p=>has(p))) && !!queryOne('SELECT 1 FROM job_orders WHERE id=?',id);
    case 'qc_remark': return moduleEnabled('manufacturing') && (has('production.view') || has('production.inspect_qc') || has('production.inspect_qa') || has('production.qa_review')) && !!queryOne('SELECT 1 FROM qc_records WHERE id=?',id);
    case 'employee_doc': return moduleEnabled('hr') && has('hr.view') && !!queryOne('SELECT 1 FROM employee_documents WHERE id=?',id);
    case 'form_record': {
      const row=queryOne<{scope:string|null;slug:string}>('SELECT f.scope,f.slug FROM form_records r JOIN form_definitions f ON f.id=r.form_def_id WHERE r.id=?',id);
      if (!row) return false;
      if (row.slug === PAYROLL_FORM_SLUG) return moduleEnabled('hr') && has('payroll.view');
      return row.scope ? has('forms.manage.'+row.scope) : ['hr','inventory','admin','accounting'].every(scope=>has('forms.manage.'+scope));
    }
    default: return false;
  }
}

export interface RetrievedChunk {
  ref: string; source_type: string; snippet: string; score: number;
}

export function retrieve(
  query: string,
  user: AuthUser,
  opts: { source_types?: string[]; k?: number } = {}
): RetrievedChunk[] {
  maybeReindex();
  const terms = String(query || '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 1).slice(0, 24);
  if (!terms.length) return [];
  const match = terms.map((w) => `"${w}"`).join(' OR ');

  let rows: Array<{ ref_label: string; source_type: string; source_id: string; acl: string; dept_id: unknown; snippet: string; score: number }>;
  try {
    rows = queryAll(
      `SELECT ref_label, source_type, source_id, acl, dept_id,
              snippet(doc_chunks, 0, '', '', ' … ', 20) AS snippet, bm25(doc_chunks) AS score
       FROM doc_chunks WHERE doc_chunks MATCH ? ORDER BY score LIMIT 60`,
      match
    );
  } catch {
    return [];
  }

  const wantTypes = opts.source_types?.length ? new Set(opts.source_types) : null;
  const k = opts.k ?? 6;
  const out: RetrievedChunk[] = [];
  for (const r of rows) {
    if (wantTypes && !wantTypes.has(r.source_type)) continue;
    if (!canSee(r, user)) continue;
    out.push({
      ref: r.ref_label,
      source_type: r.source_type,
      snippet: r.snippet,
      score: Math.round(r.score * 1000) / 1000,
    });
    if (out.length >= k) break;
  }
  return out;
}
