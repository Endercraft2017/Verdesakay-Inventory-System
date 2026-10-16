/** Content-versioned asset URLs for the desktop app shell.
 *
 * The shell (public/index.html) is rewritten as it is served so every local script/style
 * reference carries `?v=<hash of that file's bytes>`. A request whose `v` matches the file's
 * current content is answered `immutable` for a year, so the browser and the CDN in front of
 * the cloud (Cloudflare) keep it and never ask again; an edited file gets a new hash, hence a
 * new URL, on the next shell load. Requests without a matching `v` (lazily loaded scripts, an
 * old shell after a deploy) keep the revalidate-every-time `no-cache` policy.
 *
 * The phone app's shell is deliberately left alone: its service worker precaches the plain
 * URLs (public/mobile/sw.js), and versioned ones would miss that cache offline. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Per file: the stat it was hashed at (mtime + size) and the hash. A changed stat rehashes,
 *  so an edit on a running server (local development) is picked up without a restart. */
const hashes = new Map<string, { stat: string; hash: string }>();

/** Short content hash of a file, or null when it isn't a readable file. */
export function assetHash(file: string): string | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const stat = `${st.mtimeMs}:${st.size}`;
  const hit = hashes.get(file);
  if (hit && hit.stat === stat) return hit.hash;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  hashes.set(file, { stat, hash });
  return hash;
}

const LOCAL_ASSET = /\b(src|href)="\/(?!\/)([^"?#]+\.(?:js|css|svg|png|ico|woff2?))"/g;

/** Append `?v=<content hash>` to every root-relative asset reference that exists under
 *  `publicRoot`. Run before any base-path prefixing (the paths must still map onto public/). */
export function versionAssetUrls(html: string, publicRoot: string): string {
  return html.replace(LOCAL_ASSET, (whole, attr: string, rel: string) => {
    const hash = assetHash(path.join(publicRoot, rel));
    return hash ? `${attr}="/${rel}?v=${hash}"` : whole;
  });
}

export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Cache-Control for a static file: immutable only when the request names the file's current
 *  content (`?v=` matches), otherwise revalidate every time. */
export function staticCacheControl(file: string, v: unknown): string {
  return typeof v === 'string' && v !== '' && v === assetHash(file) ? IMMUTABLE : 'no-cache';
}
