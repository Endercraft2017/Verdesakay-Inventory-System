/**
 * The site host's plain-HTTP listener (docs/OFFLINE-FIRST.md §5, D5). A phone can't trust the
 * host's HTTPS until it has installed the host's certificate authority, so this listener serves:
 *
 *   GET /  or /phone-setup   step-by-step page (Android / iPhone) with the download link
 *   GET /site-certificate.crt  the authority's certificate (public — it signs, it isn't secret)
 *   anything else            301 to the HTTPS app on the same host
 *
 * Install it once per phone; afterwards https://<host>:<port>/m works offline on the office Wi-Fi.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(o: { httpsUrl: string; fingerprint: string; org: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up this phone</title>
<style>
  :root { --fg:#1d2433; --muted:#5b6475; --bg:#f6f7fb; --card:#fff; --accent:#2b7fff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e7eaf2; --muted:#9aa3b5; --bg:#12151c; --card:#1b1f29; --accent:#8aa0ff; } }
  body { margin:0; padding:16px; font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--fg); background:var(--bg); }
  main { max-width:560px; margin:0 auto; }
  section { background:var(--card); border-radius:12px; padding:16px; margin:12px 0; }
  .btn { display:block; text-align:center; padding:14px; border-radius:10px; background:var(--accent); color:#fff; text-decoration:none; font-weight:600; }
  .muted { color:var(--muted); font-size:14px; }
  code { word-break:break-all; font-size:12px; }
  ol { padding-left:20px; } li { margin:6px 0; }
</style></head><body><main>
<h1>Set up this phone for ${esc(o.org)}</h1>
<p class="muted">Do this once per phone. It lets the app work on the office Wi-Fi even when the internet is down.</p>
<section>
  <a class="btn" href="/site-certificate.crt">1. Download the site certificate</a>
</section>
<section>
  <h2>Android</h2>
  <ol>
    <li>Open <b>Settings → Security</b> (or <b>Security &amp; privacy → More security settings</b>).</li>
    <li>Tap <b>Encryption &amp; credentials → Install a certificate → CA certificate</b>.</li>
    <li>Tap <b>Install anyway</b>, then pick the downloaded <b>site-certificate.crt</b>.</li>
  </ol>
</section>
<section>
  <h2>iPhone / iPad</h2>
  <ol>
    <li>Open the download in <b>Safari</b> and tap <b>Allow</b>.</li>
    <li>Open <b>Settings → Profile Downloaded → Install</b> (enter your passcode).</li>
    <li>Then <b>Settings → General → About → Certificate Trust Settings</b> and switch on the site certificate.</li>
  </ol>
</section>
<section>
  <a class="btn" href="${esc(o.httpsUrl)}/m">2. Open the app</a>
  <p class="muted">Add it to your home screen from the browser menu.</p>
</section>
<p class="muted">Check before installing — the certificate's SHA-256 fingerprint is:<br><code>${esc(o.fingerprint)}</code></p>
</main></body></html>`;
}

export function phoneSetupHandler(o: { caCert: string; fingerprint: string; httpsPort: number; org?: string }) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const hostOnly = (req.headers.host || 'localhost').replace(/:\d+$/, '');
    const httpsUrl = `https://${hostOnly}:${o.httpsPort}`;
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/phone-setup')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page({ httpsUrl, fingerprint: o.fingerprint, org: o.org ?? 'Otom' }));
      return;
    }
    if (req.method === 'GET' && url === '/site-certificate.crt') {
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="site-certificate.crt"',
        'cache-control': 'no-store',
      });
      res.end(o.caCert);
      return;
    }
    res.writeHead(301, { location: `${httpsUrl}${req.url || '/'}` });
    res.end();
  };
}
