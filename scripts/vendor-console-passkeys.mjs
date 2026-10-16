// Pinned self-hosted browser bundle; no runtime CDN or vendored handwritten crypto.
import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
await build({ entryPoints: ['node_modules/@simplewebauthn/browser/esm/index.js'], bundle: true,
  format: 'iife', globalName: 'ConsoleWebAuthn', minify: true, outfile: 'web-console/vendor/webauthn.js' });
await copyFile('node_modules/@simplewebauthn/browser/LICENSE.md', 'web-console/vendor/webauthn-LICENSE.md');
