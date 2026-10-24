import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { it, expect } from 'vitest';

const root = path.join(import.meta.dirname, '..');
const tsxLoader = createRequire(import.meta.url).resolve('tsx');
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(4000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}

for (const mode of ['absent', 'existing', 'file'] as const) {
  it(`real browser fixture handles ${mode} capture output without relying on prior runs`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-startup-regression-'));
    const output = path.join(cwd, 'work');
    if (mode === 'existing') {
      fs.mkdirSync(output);
      fs.writeFileSync(path.join(output, 'sentinel.txt'), 'synthetic previous output');
    } else if (mode === 'file') fs.writeFileSync(output, 'synthetic occupied path');
    expect(fs.existsSync(output)).toBe(mode !== 'absent');
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', tsxLoader, path.join(root, 'tests/e2e/server.ts')], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', E2E_HOST: '127.0.0.1', E2E_PORT: String(port) },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const observations: unknown[] = [];
    try {
      const deadline = Date.now() + 45000;
      let healthy = false;
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
          const body = await response.json();
          observations.push({ status: response.status, body });
          if (response.status === 200 && body.ok === true) { healthy = true; break; }
        } catch { /* The real fixture is still starting; process failure is checked below. */ }
        await delay(100);
      }
      if (mode === 'file') {
        expect(healthy).toBe(false);
        expect(child.exitCode, stderr).toBe(1);
        expect(stderr).toMatch(/EEXIST|ENOTDIR/);
        expect(fs.readFileSync(output, 'utf8')).toBe('synthetic occupied path');
      } else {
        expect(healthy, stderr).toBe(true);
        const capture = path.join(output, 'payroll-email-browser-wire.json');
        expect(Array.isArray(JSON.parse(fs.readFileSync(capture, 'utf8')))).toBe(true);
        // Recheck after several real timer passes; a fleeting healthy response is insufficient.
        await delay(350);
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        expect(response.status).toBe(200);
        expect((await response.json()).ok).toBe(true);
        expect(child.exitCode).toBeNull();
        if (mode === 'existing') expect(fs.readFileSync(path.join(output, 'sentinel.txt'), 'utf8')).toBe('synthetic previous output');
      }
    } finally {
      await stop(child);
      const evidence = process.env.BROWSER_STARTUP_EVIDENCE_DIR;
      if (evidence) {
        fs.mkdirSync(evidence, { recursive: true });
        fs.writeFileSync(path.join(evidence, `startup-${mode}.json`), JSON.stringify({ mode, node: process.versions.node, cwd, exitCode: child.exitCode, signal: child.signalCode, observations, stdout, stderr }, null, 2) + '\n');
      }
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);
}
