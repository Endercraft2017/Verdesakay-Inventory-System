/** Confidential (anonymous) reporting — /api/anonymous-reports (reporter, identity-free) and
 *  /api/confidential-reports (case handlers, reports.confidential). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupApp, cleanup, login, createEmployee, type TestContext } from './helpers';
import { SECRET, jpegWithMetadata, pngWithMetadata, webpWithMetadata } from './image-fixtures';
// Dynamic import after setupApp() sets DB_PATH (see helpers.ts).
let queryAll: typeof import('../src/shared/db').queryAll;
let queryOne: typeof import('../src/shared/db').queryOne;
let resetTicketQuota: typeof import('../src/core/confidential-reports').resetTicketQuota;
let TICKETS_PER_DAY: number;
let PHOTOS_PER_POST: number;

let ctx: TestContext;
let adminToken: string;
let employee: { id: number; token: string };
let hrUser: { id: number; token: string };
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  ctx = await setupApp();
  ({ queryAll, queryOne } = await import('../src/shared/db'));
  ({ resetTicketQuota, TICKETS_PER_DAY, PHOTOS_PER_POST } = await import('../src/core/confidential-reports'));
  adminToken = await login(ctx.api);
  employee = await createEmployee(ctx.api, adminToken, { role: 'admin_staff', full_name: 'Reporter Person' });
  hrUser = await createEmployee(ctx.api, adminToken, { role: 'hr', full_name: 'Case Handler' });
});
afterAll(() => cleanup(ctx));

async function ticket(token = employee.token): Promise<string> {
  const r = await ctx.api.post('/api/anonymous-reports/ticket').set(bearer(token));
  expect(r.status).toBe(200);
  return r.body.ticket as string;
}

async function file(extra: Record<string, unknown> = {}) {
  const t = await ticket();
  // Sent WITH the employee's bearer token and an Idempotency-Key on purpose: the server must
  // ignore both rather than record who sent it.
  return ctx.api.post('/api/anonymous-reports')
    .set(bearer(employee.token))
    .set('Idempotency-Key', 'anon-test-key-' + Math.random().toString(36).slice(2))
    .send({ ticket: t, category: 'Safety risk', subject: 'Blocked exit', description: 'The fire exit near line 2 is blocked by pallets.', incident_date: '2026-09-20', location: 'Line 2', ...extra });
}

describe('reporter channel', () => {
  it('requires a signed-in employee to get a ticket', async () => {
    const r = await ctx.api.post('/api/anonymous-reports/ticket');
    expect(r.status).toBe(401);
  });

  it('files a report and stores no reporter identity, time, IP or request trail', async () => {
    const r = await file();
    expect(r.status).toBe(201);
    expect(r.body.number).toMatch(/^CR-\d{5}$/);
    expect(r.body.access_code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);

    // The table has no column that could hold an identity.
    const cols = queryAll<{ name: string }>('PRAGMA table_info(anonymous_reports)').map((c) => c.name).sort();
    expect(cols).toEqual(['access_hash', 'category', 'created_on', 'description', 'id', 'incident_date', 'location', 'number', 'status', 'subject', 'updated_on'].sort());
    const row = queryOne<Record<string, string>>('SELECT * FROM anonymous_reports WHERE number = ?', r.body.number)!;
    expect(row.created_on).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date only, never a time
    expect(row.access_hash).not.toContain(r.body.access_code);
    const ticketCols = queryAll<{ name: string }>('PRAGMA table_info(anonymous_report_tickets)').map((c) => c.name).sort();
    expect(ticketCols).toEqual(['expires_at', 'token_hash']);

    // Not in the activity log (which records user, IP and body), nor in the idempotency store.
    expect(queryAll("SELECT id FROM activity_log WHERE path LIKE '/api/anonymous-reports%'")).toHaveLength(0);
    expect(queryAll("SELECT key FROM idempotency_keys WHERE path LIKE '%anonymous-reports%'")).toHaveLength(0);
    // Numbering doesn't go through settings (settings.updated_at would timestamp the submission).
    expect(queryAll("SELECT key FROM settings WHERE key LIKE '%confidential%' OR key LIKE '%anonymous%'")).toHaveLength(0);
    // And nothing lands in the identified channels.
    expect(queryAll("SELECT id FROM messages WHERE body LIKE '%fire exit near line 2%'")).toHaveLength(0);
    expect(queryAll("SELECT id FROM bug_reports WHERE steps_to_reproduce LIKE '%fire exit%'")).toHaveLength(0);
  });

  it('refuses a missing, forged or reused ticket', async () => {
    const noTicket = await ctx.api.post('/api/anonymous-reports').send({ category: 'Other', description: 'Something long enough to pass.' });
    expect(noTicket.status).toBe(400);
    const forged = await ctx.api.post('/api/anonymous-reports').send({ ticket: 'x'.repeat(32), category: 'Other', description: 'Something long enough to pass.' });
    expect(forged.status).toBe(403);
    const t = await ticket();
    const body = { ticket: t, category: 'Other', description: 'First use of this ticket works.' };
    expect((await ctx.api.post('/api/anonymous-reports').send(body)).status).toBe(201);
    expect((await ctx.api.post('/api/anonymous-reports').send(body)).status).toBe(403);
  });

  it('validates category and description', async () => {
    const t = await ticket();
    const bad = await ctx.api.post('/api/anonymous-reports').send({ ticket: t, category: 'Gossip', description: 'short' });
    expect(bad.status).toBe(400);
  });

  it('caps tickets per employee per day', async () => {
    resetTicketQuota();
    for (let i = 0; i < TICKETS_PER_DAY; i++) await ticket();
    const over = await ctx.api.post('/api/anonymous-reports/ticket').set(bearer(employee.token));
    expect(over.status).toBe(429);
    resetTicketQuota();
  });

  it('lets the reporter look up and follow up with the number + access code only', async () => {
    const { body: filed } = await file();
    const wrong = await ctx.api.post('/api/anonymous-reports/lookup').send({ number: filed.number, access_code: 'AAAAA-AAAAA-AAAAA-AAAAA' });
    expect(wrong.status).toBe(404);
    // Case- and dash-insensitive.
    const ok = await ctx.api.post('/api/anonymous-reports/lookup').send({ number: filed.number.toLowerCase(), access_code: filed.access_code.replace(/-/g, '').toLowerCase() });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ number: filed.number, status: 'new', category: 'Safety risk', messages: [] });
    expect(ok.body).not.toHaveProperty('description_hash');
    expect(ok.body).not.toHaveProperty('access_hash');

    const fu = await ctx.api.post('/api/anonymous-reports/followup').send({ ...filed, body: 'It is still blocked today.' });
    expect(fu.status).toBe(201);
    expect(fu.body.messages).toEqual([expect.objectContaining({ author: 'reporter', body: 'It is still blocked today.' })]);
    const msgCols = queryAll<{ name: string }>('PRAGMA table_info(anonymous_report_messages)').map((c) => c.name);
    expect(msgCols).not.toContain('user_id');
    expect(queryOne<{ handler_id: number | null }>("SELECT handler_id FROM anonymous_report_messages WHERE author = 'reporter'")!.handler_id).toBeNull();
  });
});

describe('photos', () => {
  const base = { category: 'Safety risk', description: 'Exposed wiring beside the mixer on line 3.' };
  async function fileWithPhotos(photos: Array<{ buf: Buffer; name: string; type?: string }>, t?: string) {
    const req = ctx.api.post('/api/anonymous-reports').set(bearer(employee.token));
    req.field('ticket', t ?? await ticket());
    for (const [k, v] of Object.entries(base)) req.field(k, v);
    for (const p of photos) req.attach('photos', p.buf, { filename: p.name, contentType: p.type || 'image/jpeg' });
    return req;
  }

  it('strips identifying metadata, keeps no filename or file on disk, and shows the handler the photo', async () => {
    const { uploadDir } = await import('../src/shared/db');
    const fs = await import('node:fs');
    const filesBefore = fs.readdirSync(uploadDir()).length;

    const r = await fileWithPhotos([
      { buf: jpegWithMetadata(6), name: 'IMG_20260928_143012.jpg' },
      { buf: pngWithMetadata(), name: 'Screenshot Juan.png', type: 'image/png' },
    ]);
    expect(r.status).toBe(201);

    const cols = queryAll<{ name: string }>('PRAGMA table_info(anonymous_report_attachments)').map((c) => c.name).sort();
    expect(cols).toEqual(['created_on', 'data', 'id', 'message_id', 'mime_type', 'report_id', 'size_bytes']);
    const rows = queryAll<{ data: Uint8Array; mime_type: string; created_on: string }>(
      `SELECT a.data, a.mime_type, a.created_on FROM anonymous_report_attachments a
       JOIN anonymous_reports r ON r.id = a.report_id WHERE r.number = ? ORDER BY a.id`, r.body.number
    );
    expect(rows.map((x) => x.mime_type)).toEqual(['image/jpeg', 'image/png']);
    for (const row of rows) {
      expect(Buffer.from(row.data).includes(Buffer.from(SECRET))).toBe(false);
      expect(row.created_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(fs.readdirSync(uploadDir()).length).toBe(filesBefore); // nothing written to UPLOAD_DIR

    // Handler sees and can fetch them (stripped bytes, generic filename).
    const list = await ctx.api.get('/api/confidential-reports').set(bearer(hrUser.token));
    const item = list.body.find((x: { number: string }) => x.number === r.body.number);
    expect(item.photo_count).toBe(2);
    const detail = await ctx.api.get(`/api/confidential-reports/${item.id}`).set(bearer(hrUser.token));
    expect(detail.body.attachments).toHaveLength(2);
    const img = await ctx.api.get('/api' + detail.body.attachments[0].url).set(bearer(hrUser.token)).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/jpeg/);
    expect(img.headers['content-disposition']).not.toMatch(/IMG_2026/);
    expect(Buffer.from(img.body).includes(Buffer.from(SECRET))).toBe(false);
    // Only for case handlers.
    expect((await ctx.api.get('/api' + detail.body.attachments[0].url).set(bearer(employee.token))).status).toBe(403);

    // The reporter sees a count, never an image URL.
    const seen = await ctx.api.post('/api/anonymous-reports/lookup').send(r.body);
    expect(seen.body.photo_count).toBe(2);
    expect(JSON.stringify(seen.body)).not.toMatch(/attachments\//);
  });

  it('lets the reporter view and remove their own photos until a handler has loaded them', async () => {
    const r = await fileWithPhotos([{ buf: jpegWithMetadata(), name: 'a.jpg' }, { buf: pngWithMetadata(), name: 'b.png', type: 'image/png' }]);
    const creds = { number: r.body.number, access_code: r.body.access_code };
    const seen = await ctx.api.post('/api/anonymous-reports/lookup').send(creds);
    expect(seen.body.photos).toEqual([{ id: expect.any(Number), removable: true }, { id: expect.any(Number), removable: true }]);
    const [a, b] = seen.body.photos as Array<{ id: number }>;

    // View: code in the body; stripped bytes; a wrong code or another report's photo → 404.
    const img = await ctx.api.post('/api/anonymous-reports/photo').send({ ...creds, photo_id: a!.id }).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/jpeg/);
    expect(Buffer.from(img.body).includes(Buffer.from(SECRET))).toBe(false);
    expect((await ctx.api.post('/api/anonymous-reports/photo').send({ ...creds, access_code: 'AAAAA-AAAAA-AAAAA-AAAAA', photo_id: a!.id })).status).toBe(404);
    const other = await file();
    expect((await ctx.api.post('/api/anonymous-reports/photo').send({ number: other.body.number, access_code: other.body.access_code, photo_id: a!.id })).status).toBe(404);

    // Remove one before any handler opens the case.
    const rm = await ctx.api.post('/api/anonymous-reports/photo/remove').send({ ...creds, photo_id: a!.id });
    expect(rm.status).toBe(200);
    expect(rm.body.photos).toEqual([{ id: b!.id, removable: true }]);
    expect(queryOne('SELECT id FROM anonymous_report_attachments WHERE id = ?', a!.id)).toBeUndefined();

    // A handler opens the case → the rest can no longer be removed.
    const item = (await ctx.api.get('/api/confidential-reports').set(bearer(hrUser.token))).body.find((x: { number: string }) => x.number === creds.number);
    await ctx.api.get(`/api/confidential-reports/${item.id}`).set(bearer(hrUser.token));
    expect((await ctx.api.post('/api/anonymous-reports/lookup').send(creds)).body.photos).toEqual([{ id: b!.id, removable: false }]);
    const late = await ctx.api.post('/api/anonymous-reports/photo/remove').send({ ...creds, photo_id: b!.id });
    expect(late.status).toBe(409);
    expect(queryOne('SELECT id FROM anonymous_report_attachments WHERE id = ?', b!.id)).toBeTruthy();

    // A photo added in a later follow-up is removable again until the handler loads it.
    const fu = await ctx.api.post('/api/anonymous-reports/followup')
      .field('number', creds.number).field('access_code', creds.access_code).field('body', 'One more.')
      .attach('photos', jpegWithMetadata(), { filename: 'c.jpg', contentType: 'image/jpeg' });
    expect(fu.body.messages.at(-1).photos).toEqual([{ id: expect.any(Number), removable: true }]);
    // The handler-seen marker keeps no date or time.
    expect(queryAll<{ name: string }>('PRAGMA table_info(anonymous_report_handler_seen)').map((c) => c.name).sort()).toEqual(['last_photo_id', 'report_id']);
  });

  it('refuses a non-photo or unreadable file without using up the ticket', async () => {
    const t = await ticket();
    const bad = await fileWithPhotos([{ buf: Buffer.from('%PDF-1.7 ' + SECRET), name: 'evidence.jpg' }], t);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Only photos/);
    const again = await fileWithPhotos([{ buf: jpegWithMetadata(), name: 'a.jpg' }], t);
    expect(again.status).toBe(201);
  });

  it('caps photos per submission', async () => {
    const five = Array.from({ length: PHOTOS_PER_POST + 1 }, (_, i) => ({ buf: jpegWithMetadata(), name: `p${i}.jpg` }));
    const r = await fileWithPhotos(five);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/up to 4 photos/);
  });

  it('accepts photos on a reporter follow-up, stripped the same way', async () => {
    const { body: filed } = await file();
    const fu = await ctx.api.post('/api/anonymous-reports/followup')
      .field('number', filed.number).field('access_code', filed.access_code).field('body', 'Photo of the blocked exit.')
      .attach('photos', webpWithMetadata(), { filename: 'x.webp', contentType: 'image/webp' });
    expect(fu.status).toBe(201);
    expect(fu.body.messages.at(-1)).toMatchObject({ author: 'reporter', photo_count: 1 });
    const row = queryOne<{ data: Uint8Array; message_id: number | null }>(
      `SELECT a.data, a.message_id FROM anonymous_report_attachments a JOIN anonymous_reports r ON r.id = a.report_id WHERE r.number = ?`,
      filed.number
    )!;
    expect(row.message_id).not.toBeNull();
    expect(Buffer.from(row.data).includes(Buffer.from(SECRET))).toBe(false);
  });
});

describe('case handlers', () => {
  it('is limited to reports.confidential (HR + admin by default)', async () => {
    expect((await ctx.api.get('/api/confidential-reports').set(bearer(employee.token))).status).toBe(403);
    expect((await ctx.api.get('/api/confidential-reports').set(bearer(hrUser.token))).status).toBe(200);
    expect((await ctx.api.get('/api/confidential-reports').set(bearer(adminToken))).status).toBe(200);
    const { HR_GRANTABLE_PERMISSIONS } = await import('../src/shared/permissions');
    expect(HR_GRANTABLE_PERMISSIONS).not.toContain('reports.confidential'); // HR can't hand it to floor staff
  });

  it('triages, replies and closes; the reporter sees the reply but not who wrote it', async () => {
    const { body: filed } = await file({ subject: 'Handler flow' });
    const list = await ctx.api.get('/api/confidential-reports?status=new').set(bearer(hrUser.token));
    const item = list.body.find((r: { number: string }) => r.number === filed.number);
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty('access_hash');

    expect((await ctx.api.post(`/api/confidential-reports/${item.id}/status`).set(bearer(hrUser.token)).send({ status: 'investigating' })).status).toBe(200);
    const reply = await ctx.api.post(`/api/confidential-reports/${item.id}/reply`).set(bearer(hrUser.token)).send({ body: 'Thank you — facilities is clearing it.' });
    expect(reply.status).toBe(201);
    expect(reply.body.messages.at(-1)).toMatchObject({ author: 'handler', handler_name: 'Case Handler' });
    expect(reply.body).not.toHaveProperty('access_hash');
    // Handler actions are audited like any other staff action.
    expect(queryAll(`SELECT id FROM activity_log WHERE path = '/api/confidential-reports/${item.id}/reply'`).length).toBe(1);

    const seen = await ctx.api.post('/api/anonymous-reports/lookup').send(filed);
    expect(seen.body.status).toBe('investigating');
    expect(seen.body.messages.at(-1)).toEqual(expect.objectContaining({ author: 'handler', body: 'Thank you — facilities is clearing it.' }));
    expect(seen.body.messages.at(-1)).not.toHaveProperty('handler_name');

    await ctx.api.post(`/api/confidential-reports/${item.id}/status`).set(bearer(hrUser.token)).send({ status: 'closed' });
    const late = await ctx.api.post('/api/anonymous-reports/followup').send({ ...filed, body: 'One more thing' });
    expect(late.status).toBe(409);
  });

  it('rejects an unknown status', async () => {
    const r = await ctx.api.post('/api/confidential-reports/1/status').set(bearer(adminToken)).send({ status: 'deleted' });
    expect(r.status).toBe(400);
  });
});
