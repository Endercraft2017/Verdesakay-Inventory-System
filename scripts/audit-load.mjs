/** Local capacity probe only: starts a throwaway fixture, never accepts a remote URL.
 * npm run test:load. These numbers are not production capacity guarantees. */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const server = spawn(process.execPath, ['--import', 'tsx', 'tests/e2e/server.ts'], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, E2E_HOST: '127.0.0.1' } });
const base = 'http://127.0.0.1:4173';
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(base + '/api/health')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Isolated fixture failed to start');
  const session = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) })).json();
  const headers = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };
  for (let i = 0; i < 100; i++) {
    const result = await fetch(base + '/api/inventory', { method: 'POST', headers, body: JSON.stringify({ name: 'Capacity fixture ' + i, quantity: 100 }) });
    if (!result.ok) throw new Error('Fixture seed failed');
  }
  const results = [];
  for (const concurrency of [5, 15, 30]) {
    const times = []; let failures = 0; let next = 0;
    const start = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = next++; if (index >= 150) break;
        const before = performance.now();
        try {
          const path = index % 3 === 0 ? '/api/orders' : index % 3 === 1 ? '/api/inventory' : '/api/auth/me';
          const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(10000) });
          await response.arrayBuffer(); if (!response.ok) failures++;
        } catch { failures++; }
        times.push(performance.now() - before);
      }
    }));
    times.sort((a,b) => a-b);
    results.push({ concurrency, requests: times.length, failures, p50_ms: times[Math.floor(times.length*.5)], p95_ms: times[Math.floor(times.length*.95)], p99_ms: times[Math.floor(times.length*.99)], requests_per_second: times.length / ((performance.now() - start)/1000) });
  }
  console.log(JSON.stringify({ environment: 'local synthetic, 100 inventory items; read-only mixed API traffic; test-mode rate limits disabled', results }, null, 2));
  if (results.some(r => r.failures)) process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
}
