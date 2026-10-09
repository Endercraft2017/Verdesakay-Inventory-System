/**
 * Maintenance-only start command for data cutovers (docs/VERDESAKAY-TENANT-CUTOVER.md).
 * Keeps Railway's /api/health check green while the real app is stopped, so the volume
 * has NO writer: it imports nothing from the app and never opens a database or upload.
 * Every other request gets 503 + Retry-After so browsers and phones keep their work queued.
 */
import http from 'node:http';

const port = Number(process.env.PORT) || 3000;
const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Maintenance</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px">'
  + '<h1>Scheduled maintenance</h1><p>The system is being moved to its new address. Please try again shortly.</p></body>';

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, maintenance: true }));
    return;
  }
  const api = url.includes('/api/');
  res.writeHead(503, { 'content-type': api ? 'application/json' : 'text/html; charset=utf-8', 'retry-after': '600', 'cache-control': 'no-store' });
  res.end(api ? JSON.stringify({ error: 'Scheduled maintenance. Try again shortly.', maintenance: true }) : html);
}).listen(port, () => console.log(`MAINTENANCE_MODE listening on ${port}; app and database writers are not running.`));
