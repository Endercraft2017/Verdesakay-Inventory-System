/** Public, allowlisted policy drafts. No tenant data, arbitrary paths or Markdown HTML. */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
const router = Router();
const directory = path.resolve(import.meta.dirname, '../../docs/policies');
const pages: Record<string, string> = { privacy: 'Privacy notice', terms: 'Terms of service', refunds: 'Refunds and cancellation', security: 'Security information', 'data-rights': 'Data rights', ai: 'AI use notice' };
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
router.get(['/', '/:page'], (req, res) => {
  const page = typeof req.params.page === 'string' ? req.params.page : undefined;
  if (page && !Object.hasOwn(pages, page)) { res.status(404).send('Policy not found.'); return; }
  const base = String(res.locals.tenantBase || '') + '/policies';
  const title = page ? pages[page]! : 'Policies and security';
  const links = Object.entries(pages).map(([key, label]) => `<li><a href="${escape(base)}/${key}">${escape(label)}</a></li>`).join('');
  const text = page ? fs.readFileSync(path.join(directory, `${page}.md`), 'utf8') : 'These policy drafts describe the application. The owner must complete and approve them before launch. Contact details and contractual terms are not yet final.';
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} — Verdesakay</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:850px;margin:2rem auto;padding:0 1rem;color:#182c24;background:#fff}a{color:#145d42}pre{white-space:pre-wrap;font:inherit}aside{padding:1rem;background:#fff3ce;border:1px solid #a77a16}</style></head><body><header><a href="${escape(base)}">Policies</a><h1>${escape(title)}</h1></header><main><aside>Draft — requires owner and legal approval before launch. No contractual commitments or certification are established by this page.</aside><nav aria-label="Policies"><ul>${links}</ul></nav><pre>${escape(text)}</pre></main></body></html>`);
});
export default router;
