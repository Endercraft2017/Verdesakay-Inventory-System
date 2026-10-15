// Browser tests must never read development or production data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-playwright-'));
Object.assign(process.env, {
  NODE_ENV: 'test', TZ: 'Asia/Manila',
  DB_PATH: path.join(dir, 'app.db'), DATA_DIR: path.join(dir, 'data'),
  PLATFORM_DB_PATH: path.join(dir, 'platform.db'), UPLOAD_DIR: path.join(dir, 'uploads'),
  BACKUP_DIR: path.join(dir, 'backups'),
});
for (const key of ['APP_DOMAIN', 'TENANT_PATH_HOST', 'DEFAULT_TENANT_REDIRECT', 'PLATFORM_CONSOLE', 'ADMIN_PASSWORD', 'DEPLOY_MODE']) delete process.env[key];
const db = await import('../../src/shared/db');
db.init();
const { createApp } = await import('../../src/app');
const { attachWebSocket } = await import('../../src/shared/ws');
const server = createApp().listen(4173, process.env.E2E_HOST || '127.0.0.1');
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
