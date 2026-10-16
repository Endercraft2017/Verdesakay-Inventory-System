// Browser tests must never read development or production data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { recoveryUsername, recoveryFixtureToken, cancellationId, cancellationNonce } from './recovery-fixture';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-playwright-'));
Object.assign(process.env, {
  VDS_TEST_ADMIN_PASSWORD: 'admin123', NODE_ENV: 'test', TZ: 'Asia/Manila',
  DB_PATH: path.join(dir, 'app.db'), DATA_DIR: path.join(dir, 'data'),
  PLATFORM_DB_PATH: path.join(dir, 'platform.db'), UPLOAD_DIR: path.join(dir, 'uploads'),
  BACKUP_DIR: path.join(dir, 'backups'),
});
for (const key of ['APP_DOMAIN', 'TENANT_PATH_HOST', 'DEFAULT_TENANT_REDIRECT', 'PLATFORM_CONSOLE', 'ADMIN_PASSWORD', 'DEPLOY_MODE']) delete process.env[key];
process.env.PLATFORM_CONSOLE = 'true';
process.env.PLATFORM_WEBAUTHN_ORIGIN = 'http://localhost:4173';
const { upsertPlatformUser } = await import('../../src/platform/platform-users');
upsertPlatformUser('browser-operator', 'Synthetic browser operator password', 'Browser Operator');
const db = await import('../../src/shared/db');
db.init();
const { hashPassword } = await import('../../src/shared/password-hash');
const { credentialStamp } = await import('../../src/shared/account-recovery');
const oldHash = hashPassword(randomUUID());
const recovered = db.run("INSERT INTO users(username,full_name,password_hash,role,email) VALUES(?,?,?,'warehouse','browser-recovery@example.test')", recoveryUsername, 'Browser recovery', oldHash);
const recoveredId = Number(recovered.lastInsertRowid);
const digest = createHash('sha256').update(recoveryFixtureToken).digest('hex');
db.run("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,datetime('now','+15 minutes'))", digest, recoveredId);
db.run("INSERT INTO account_recoveries(token_hash,user_id,requested_by,approved_by,reason,verification_reference,contact_email,credential_hash) VALUES(?,?,'platform:1','platform:2','Synthetic independently approved browser recovery','E2E-RECOVERY','browser-recovery@example.test',?)", digest, recoveredId, credentialStamp(oldHash));
// Only the public cancellation boundary is exercised here; API tests create real approval cases.
const { platformDb } = await import('../../src/platform/platform');
platformDb().exec('CREATE TABLE platform_recovery_approvals(id TEXT PRIMARY KEY,cancel_hash TEXT,slug TEXT,state TEXT,expires_at TEXT)');
platformDb().prepare("INSERT INTO platform_recovery_approvals VALUES(?,?,'default','pending',datetime('now','+48 hours'))").run(cancellationId, credentialStamp(cancellationNonce));
const { createApp } = await import('../../src/app');
const { attachWebSocket } = await import('../../src/shared/ws');
const server = createApp().listen(Number(process.env.E2E_PORT || 4173), process.env.E2E_HOST || '127.0.0.1');
attachWebSocket(server);
function stop() {
  server.closeAllConnections();
  server.close(() => {
    db.closeAllConnections();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
