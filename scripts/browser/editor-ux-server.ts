// Disposable loopback server for the editor browser audit. Never opens the application's DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otom-editor-ux-'));
process.env.NODE_ENV = 'test';
process.env.VDS_TEST_ADMIN_PASSWORD = 'admin123'; // disposable fixture, never production bootstrap
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.PLATFORM_DB_PATH = path.join(dir, 'platform.db');
process.env.UPLOAD_DIR = path.join(dir, 'uploads');
process.env.DATA_DIR = path.join(dir, 'tenants');
delete process.env.ADMIN_PASSWORD;
const { createApp } = await import('../../src/app');
const server = createApp().listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log('EDITOR_UX_PORT=' + address.port);
});
const { attachWebSocket } = await import('../../src/shared/ws');
attachWebSocket(server);
const sockets = new Set<Socket>();
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    const db = await import('../../src/shared/db');
    const platform = await import('../../src/platform/platform');
    db.closeAllConnections();
    platform._resetPlatformDb();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
  server.closeAllConnections();
  for (const socket of sockets) socket.destroy();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
