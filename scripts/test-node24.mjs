// Run the test suite on the desktop app's runtime: Electron's bundled Node (24.x, with a SQLite
// that rejects double-quoted string literals — docs/OFFLINE-FIRST.md §9). `npm run test:node24`.
// Extra arguments go to vitest, e.g. `npm run test:node24 -- tests/sync.test.ts`.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');
const vitest = path.join(import.meta.dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const child = spawn(electron, [vitest, 'run', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));
