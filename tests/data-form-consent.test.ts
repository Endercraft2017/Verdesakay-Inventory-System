import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setupApp, cleanup, login, type TestContext } from './helpers';
let ctx: TestContext;
let headers: { Authorization: string };
let formId: number;
beforeAll(async () => {
  ctx = await setupApp();
  headers = { Authorization: `Bearer ${await login(ctx.api)}` };
  const response = await ctx.api.post('/api/form-definitions').set(headers).send({
    name: 'Consent test', slug: 'consent_test', scope: 'inventory',
    fields: [{ key: 'consent', label: 'I confirm', type: 'checkbox', required: true }],
  });
  expect(response.status).toBe(201);
  formId = response.body.id;
});
afterAll(() => cleanup(ctx));
describe('required checkbox consent', () => {
  it.each([undefined, false, 'No', 'false', 'true', 1])('rejects unchecked or ambiguous value %s', async (value) => {
    const response = await ctx.api.post('/api/form-records').set(headers).send({ form_def_id: formId, data: { consent: value } });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('must be checked');
  });
  it.each([true, 'Yes'])('accepts explicit consent %s and prevents removing it on edit', async (value) => {
    const response = await ctx.api.post('/api/form-records').set(headers).send({ form_def_id: formId, data: { consent: value }, status: 'pending' });
    expect(response.status).toBe(201);
    const rejected = await ctx.api.put(`/api/form-records/${response.body.id}`).set(headers).send({ data: { consent: false } });
    expect(rejected.status).toBe(400);
    const record = await ctx.api.get(`/api/form-records/${response.body.id}`).set(headers);
    expect(record.body.data.consent).toBe(value);
    expect(record.body.status).toBe('pending');
  });
});
