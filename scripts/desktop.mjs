// Run the desktop app from the source tree: `npm run desktop` (or `npm run desktop:smoke`).
// ELECTRON_RUN_AS_NODE is removed first: editors built on Electron (VS Code) set it for their
// terminals, and with it set Electron starts as plain Node instead of as the app.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron'); // the binary's path when required from Node
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const main = path.join(import.meta.dirname, '..', 'electron', 'main.cjs');
const child = spawn(electron, [main, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));
