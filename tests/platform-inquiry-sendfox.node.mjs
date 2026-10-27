/** Real platform-mail code and SQLite; isolated platform/nodemailer fixtures prevent external writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyRoot = process.env.OTOM_TEST_APP_ROOT || root;
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const { build } = require('esbuild');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'otom-inquiry-mail-'));
await build({ entryPoints: [path.join(root, 'src/platform/platform-mail.ts')], outfile: path.join(temp, 'mail.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{
  name: 'isolated-mail-fixtures',
  setup(api) {
    api.onResolve({ filter: /^\.\/platform$/ }, () => ({ path: 'platform', namespace: 'fixture' }));
    api.onResolve({ filter: /^nodemailer$/ }, () => ({ path: 'nodemailer', namespace: 'fixture' }));
    api.onResolve({ filter: /^\.\/db$/ }, args => args.importer.endsWith('/shared/secrets.ts') ? ({ path: 'secret-db', namespace: 'fixture' }) : undefined);
    api.onResolve({ filter: /^\.\.\/shared\/secrets$/ }, () => ({ path: path.join(dependencyRoot, 'src/shared/secrets.ts') }));
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'platform'
      ? 'export const platformDb=()=>globalThis.__mailFixtureDb; export const platformHost=()=>"console.example.test";'
      : args.path === 'secret-db' ? 'export const getSetting=()=>{throw new Error("Unexpected tenant DB access")}; export const setSetting=getSetting;'
      : 'export default {createTransport:()=>({sendMail:async args=>{globalThis.__smtpFixtureCalls.push(args)}})};', loader: 'js' }));
  },
}] });
const mail = await import(pathToFileURL(path.join(temp, 'mail.mjs')).href);
const originalFetch = globalThis.fetch;
const originalInfo = console.info, originalError = console.error;
let runtimeLogs = [];
const names = ['SENDFOX_API_KEY', 'INQUIRY_FROM', 'INQUIRY_TO', 'NODE_ENV', 'APP_SECRET'];
const originalEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
function setup() {
  globalThis.__mailFixtureDb = new DatabaseSync(':memory:');
  globalThis.__smtpFixtureCalls = [];
  runtimeLogs = [];
  console.info = console.error = (...values) => { runtimeLogs.push(values.join(' ')); };
  Object.assign(process.env, { SENDFOX_API_KEY: 'fixture-token', INQUIRY_FROM: 'OTOM <notifications@example.test>', INQUIRY_TO: 'contact@example.test', NODE_ENV: 'production', APP_SECRET: 'disposable-fixture-secret' });
}
function clean() { globalThis.__mailFixtureDb.close(); console.info = originalInfo; console.error = originalError; }

test('configured SendFox delivers one inquiry alert while stored SMTP stays untouched', async () => {
  setup();
  try {
    mail.savePlatformMail({ transport: 'smtp', smtp_host: 'smtp.example.test', from_email: 'old@example.test', alert_to: 'old-owner@example.test' }, 'fixture-smtp-password');
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.deepEqual(body.to, ['contact@example.test']);
      assert.equal(body.reply_to, 'visitor@example.test');
      return new Response(JSON.stringify({ id: 'queue-id', status: 'queued' }));
    };
    await mail.notifyOwner('inquiry', 'Website inquiry', ['A synthetic workflow'], { replyTo: 'visitor@example.test' });
    assert.equal(calls, 1);
    assert.equal(globalThis.__smtpFixtureCalls.length, 0);
    assert.equal(mail.getPlatformMail().transport, 'smtp');
    assert.equal(mail.platformMailLog()[0].status, 'sent');
    assert.deepEqual(runtimeLogs, ['[platform-mail] inquiry queued via SendFox']);
  } finally { clean(); }
});

test('the inquiry alert switch still suppresses SendFox', async () => {
  setup();
  try {
    mail.savePlatformMail({ alert_inquiry: false });
    globalThis.fetch = async () => { throw new Error('must not request'); };
    await mail.notifyOwner('inquiry', 'Suppressed', ['Fixture']);
    assert.equal(mail.platformMailLog().length, 0);
  } finally { clean(); }
});

test('a failed SendFox attempt is logged once and does not fall back to SMTP', async () => {
  setup();
  try {
    mail.savePlatformMail({ transport: 'smtp', smtp_host: 'smtp.example.test', from_email: 'old@example.test', alert_to: 'old-owner@example.test' }, 'fixture-smtp-password');
    globalThis.fetch = async () => new Response(JSON.stringify({ private: 'do not log this body' }), { status: 503 });
    await mail.notifyOwner('inquiry', 'Failure fixture', ['Fixture']);
    const logs = mail.platformMailLog();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'failed');
    assert.equal(logs[0].error, 'SendFox rejected the inquiry email (HTTP 503).');
    assert.equal(globalThis.__smtpFixtureCalls.length, 0);
    assert.deepEqual(runtimeLogs, ['[platform-mail] inquiry notification failed: SendFox rejected the inquiry email (HTTP 503).']);
    assert.ok(!runtimeLogs.join(' ').includes('do not log this body'));
    assert.ok(!runtimeLogs.join(' ').includes('fixture-token'));
  } finally { clean(); }
});

test('payment alerts continue to use the existing SMTP transport', async () => {
  setup();
  try {
    mail.savePlatformMail({ transport: 'smtp', smtp_host: 'smtp.example.test', from_email: 'old@example.test', alert_to: 'old-owner@example.test' }, 'fixture-smtp-password');
    globalThis.fetch = async () => { throw new Error('SendFox must not handle payment alerts'); };
    await mail.notifyOwner('payment', 'Payment fixture', ['Fixture']);
    assert.equal(globalThis.__smtpFixtureCalls.length, 1);
    assert.deepEqual(globalThis.__smtpFixtureCalls[0].to, ['old-owner@example.test']);
    assert.equal(mail.platformMailLog()[0].status, 'sent');
  } finally { clean(); }
});

test('inquiries without a SendFox key retain the existing configured SMTP path', async () => {
  setup();
  try {
    delete process.env.SENDFOX_API_KEY;
    mail.savePlatformMail({ transport: 'smtp', smtp_host: 'smtp.example.test', from_email: 'old@example.test', alert_to: 'old-owner@example.test' }, 'fixture-smtp-password');
    globalThis.fetch = async () => { throw new Error('SendFox must not be called without configuration'); };
    await mail.notifyOwner('inquiry', 'Existing SMTP inquiry', ['Fixture']);
    assert.equal(globalThis.__smtpFixtureCalls.length, 1);
    assert.deepEqual(globalThis.__smtpFixtureCalls[0].to, ['old-owner@example.test']);
    assert.equal(mail.platformMailLog()[0].status, 'sent');
  } finally { clean(); }
});

test('NODE_ENV=test retains the existing outbox contract and makes no request', async () => {
  setup();
  try {
    process.env.NODE_ENV = 'test';
    globalThis.fetch = async () => { throw new Error('must not send'); };
    const before = mail._testOutbox.length;
    await mail.notifyOwner('inquiry', 'Dry-run fixture', ['Fixture'], { replyTo: 'visitor@example.test' });
    assert.equal(mail._testOutbox.length, before + 1);
    assert.equal(mail._testOutbox.at(-1).replyTo, 'visitor@example.test');
    assert.equal(mail.platformMailLog()[0].status, 'sent');
  } finally { clean(); }
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  delete globalThis.__mailFixtureDb;
  delete globalThis.__smtpFixtureCalls;
  await fs.rm(temp, { recursive: true, force: true });
});
