/** One-time Railway start command. Stop ALL existing writers before using this. */
import { adoptDefaultTenant } from '../src/platform/adopt-default';
import path from 'node:path';
import { spawn } from 'node:child_process';

try {
  const preview = process.argv.includes('--preview');
  if (!preview && !process.argv.includes('--writers-stopped')) {
    throw new Error('Stop the existing deployment and all other writers first, then pass --writers-stopped. This command cannot stop them for you.');
  }
  for (const key of ['DB_PATH', 'DATA_DIR', 'UPLOAD_DIR', 'PLATFORM_DB_PATH']) {
    if (!process.env[key]?.trim()) throw new Error(`Set ${key} to the existing Railway volume path before cutover.`);
  }
  if (process.env.DEFAULT_TENANT_REDIRECT && process.env.DEFAULT_TENANT_REDIRECT !== 'verdesakay') {
    throw new Error('DEFAULT_TENANT_REDIRECT already points to a different tenant.');
  }
  if (process.env.DEPLOY_MODE && process.env.DEPLOY_MODE !== 'cloud') {
    throw new Error('This command is for the cloud deployment only.');
  }
  const result = adoptDefaultTenant({ slug: 'verdesakay', name: 'Verdesakay',
    apply: !preview, serverStopped: !preview });
  console.log(JSON.stringify(result, null, 2));
  if (!preview) {
    // Set routing only AFTER the copy, hash verification and registration succeed.
    process.env.TENANT_PATH_HOST = 'otom.afkcube.com';
    process.env.APP_DOMAIN = 'otom.afkcube.com';
    process.env.DEFAULT_TENANT_REDIRECT = 'verdesakay';
    process.env.PLATFORM_CONSOLE = 'true';
    process.env.DEPLOY_MODE = 'cloud';
    process.env.TZ = 'Asia/Manila';
    console.log('Verdesakay registered. Source data retained. Starting tenant routing; replace this one-time start command with npm start and persist the routing variables in Railway.');
    // A fresh process loads module-level config constants with the cutover settings.
    const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: path.join(import.meta.dirname, '..'), env: process.env, stdio: 'inherit',
    });
    const stop = (signal: NodeJS.Signals) => { child.kill(signal); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
} catch (e) {
  console.error(`Cutover stopped: ${(e as Error).message}`);
  process.exitCode = 1;
}
