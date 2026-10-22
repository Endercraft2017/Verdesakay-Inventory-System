/** A tiny path-style S3 fake for tests: one bucket (`bk`), objects in a Map. `deny` makes
    every call 403. Used by the off-site backup and file-bucket tests. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export function fakeS3() {
  const objects = new Map<string, { body: Buffer; at: string }>();
  const state = { deny: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    if (state.deny || bucket !== 'bk' || !String(req.headers.authorization || '').startsWith('AWS4-HMAC-SHA256')) {
      res.writeHead(403); res.end('<Error><Code>AccessDenied</Code><Message>nope</Message></Error>'); return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'PUT') { objects.set(key, { body: Buffer.concat(chunks), at: new Date().toISOString() }); res.end(); return; }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && !key) {
        const prefix = url.searchParams.get('prefix') || '';
        const items = [...objects].filter(([k]) => k.startsWith(prefix))
          .map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.body.length}</Size><LastModified>${o.at}</LastModified></Contents>`).join('');
        res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`); return;
      }
      const o = objects.get(key);
      if (!o) { res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
      res.end(o.body);
    });
  });
  return { server, objects, state };
}

/** Start the fake on a free local port; returns its endpoint URL. */
export async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
