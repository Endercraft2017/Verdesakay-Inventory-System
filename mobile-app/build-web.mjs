// Bundle the phone app (/m) for the installable app (docs/OFFLINE-FIRST.md §29, phase 7a).
//
// Copies public/mobile and public/js into www/ (served inside the app at https://localhost/), and
// makes the mobile page its start page with mobile/native.js loaded first — that marks the page as
// the installed app (window.VDS_NATIVE) and asks for the server address on first launch. The
// desktop app, and anything the phone page doesn't load, stays out.
import fs from 'node:fs';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const www = path.join(here, 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
for (const dir of ['mobile', 'js']) {
  fs.cpSync(path.join(pub, dir), path.join(www, dir), { recursive: true });
}

await build({ entryPoints: [path.join(here, 'native-entry.mjs')], bundle: true, format: 'iife', minify: true,
  outfile: path.join(www, 'mobile', 'native-credentials.js') });

const nativeNotices = ['@capacitor/core', '@aparajita/capacitor-secure-storage'].map((name) =>
  name + '\n' + fs.readFileSync(path.join(here, 'node_modules', name, 'LICENSE'), 'utf8')).join('\n\n');
fs.writeFileSync(path.join(www, 'mobile', 'native-credentials-LICENSE.txt'), nativeNotices);

const page = fs.readFileSync(path.join(pub, 'mobile', 'index.html'), 'utf8');
const anchor = '<script src="/js/api.js"></script>';
if (!page.includes(anchor)) throw new Error(`public/mobile/index.html no longer loads ${anchor}; update build-web.mjs`);
const bundled = page
  .replace(anchor, `<script src="/mobile/native.js"></script>\n  <script src="/mobile/native-credentials.js"></script>\n  ${anchor}`)
  // No web manifest inside the app: it is already installed.
  .replace(/\s*<link rel="manifest"[^>]*>/, '');
fs.writeFileSync(path.join(www, 'index.html'), bundled);

const size = (p) => fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0)
  : fs.statSync(p).size;
console.log(`www/ ready: ${(size(www) / 1024 / 1024).toFixed(1)} MB`);
