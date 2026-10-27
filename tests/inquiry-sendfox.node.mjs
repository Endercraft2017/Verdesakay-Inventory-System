import test from 'node:test';
import assert from 'node:assert/strict';
import { inquirySendFoxEnabled, sendSendFoxInquiry } from '../src/platform/inquiry-mail.ts';

const env = { SENDFOX_API_KEY: 'fixture-sendfox-key', INQUIRY_FROM: 'AFK3 Website <notifications@example.test>', INQUIRY_TO: 'contact@example.test' };
const message = { subject: 'New inquiry: Demo workshop', text: 'A <sample> inquiry & handoff.', replyTo: 'visitor@example.test' };

test('queues one inquiry to the owner with visitor Reply-To and escaped HTML', async () => {
  let calls = 0;
  const result = await sendSendFoxInquiry(message, { env, request: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.sendfox.com/transactional/emails');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer fixture-sendfox-key');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.to, ['contact@example.test']);
    assert.equal(body.reply_to, 'visitor@example.test');
    assert.equal(body.from, env.INQUIRY_FROM);
    assert.equal(body.text, message.text);
    assert.match(body.html, /A &lt;sample&gt; inquiry &amp; handoff\./);
    assert.ok(!JSON.stringify(body).includes(env.SENDFOX_API_KEY));
    return new Response(JSON.stringify({ id: 'queued-fixture-1', status: 'queued' }), { status: 201 });
  } });
  assert.deepEqual(result, { ok: true, to: ['contact@example.test'], queuedId: 'queued-fixture-1' });
  assert.equal(calls, 1);
});

test('HTTP rejection reports status without reading or exposing the provider body', async () => {
  const result = await sendSendFoxInquiry(message, { env, request: async () => ({
    ok: false, status: 401, json() { throw new Error('provider body must not be read'); },
  }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SendFox rejected the inquiry email (HTTP 401).');
});

test('a 2xx response needs both a nonempty ID and queued status', async () => {
  for (const body of [{}, { id: 42, status: 'queued' }, { id: ' ', status: 'queued' }, { id: 'id', status: 'failed' }]) {
    const result = await sendSendFoxInquiry(message, { env, request: async () => new Response(JSON.stringify(body)) });
    assert.equal(result.ok, false);
    assert.equal(result.queuedId, undefined);
  }
});

test('network and invalid JSON failures are bounded generic errors without a retry', async () => {
  let calls = 0;
  for (const request of [async () => { calls++; throw new Error('Bearer fixture-sendfox-key; private body'); }, async () => { calls++; return new Response('not-json'); }]) {
    const result = await sendSendFoxInquiry(message, { env, request });
    assert.equal(result.error, 'The SendFox inquiry email request failed.');
    assert.ok(!JSON.stringify(result).includes(env.SENDFOX_API_KEY));
  }
  assert.equal(calls, 2);
});

test('missing or invalid configuration never attempts a request', async () => {
  let calls = 0;
  for (const patch of [{ SENDFOX_API_KEY: '' }, { INQUIRY_FROM: '' }, { INQUIRY_FROM: 'invalid' }, { INQUIRY_TO: 'bad' }, { INQUIRY_FROM: 'name\r\nBcc: other@example.test <owner@example.test>' }]) {
    const result = await sendSendFoxInquiry(message, { env: { ...env, ...patch }, request: async () => { calls++; throw new Error(); } });
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
  assert.equal(inquirySendFoxEnabled({}), false);
  assert.equal(inquirySendFoxEnabled({ SENDFOX_API_KEY: ' ' }), false);
  assert.equal(inquirySendFoxEnabled(env), true);
});

test('invalid Reply-To and empty content are rejected before sending', async () => {
  let calls = 0;
  for (const value of [{ ...message, replyTo: 'bad\nBcc: attacker@example.test' }, { ...message, text: ' ' }, { ...message, subject: ' ' }]) {
    const result = await sendSendFoxInquiry(value, { env, request: async () => { calls++; throw new Error(); } });
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
});

test('dry-run validates configuration but neither sends nor invents a provider receipt', async () => {
  const result = await sendSendFoxInquiry(message, { env, dryRun: true, request: async () => { throw new Error('must not send'); } });
  assert.deepEqual(result, { ok: true, to: ['contact@example.test'] });
});

test('payload limits remain finite and optional Reply-To stays absent', async () => {
  const result = await sendSendFoxInquiry({ subject: 's'.repeat(300), text: 'x'.repeat(13000) }, { env, request: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.subject.length, 220);
    assert.equal(body.text.length, 12000);
    assert.equal(body.reply_to, undefined);
    return new Response(JSON.stringify({ id: 'id', status: 'queued' }));
  } });
  assert.equal(result.ok, true);
});
