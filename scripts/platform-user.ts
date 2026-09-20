/**
 * Owner-console operator accounts (separate from every tenant's users).
 *
 *   npm run platform:user -- --username owner --password s3cret [--name "System Owner"]
 *   npm run platform:user -- --list
 *
 * The console itself is only reachable when the server runs with PLATFORM_CONSOLE=true.
 * You can also bootstrap the first operator with PLATFORM_ADMIN_USERNAME /
 * PLATFORM_ADMIN_PASSWORD env vars (seeded on boot when the table is empty).
 */
import { upsertPlatformUser, listPlatformUsers } from '../src/platform-users';

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith('--')) {
      const key = argv[i]!.slice(2);
      const val = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true';
      out[key] = val;
    }
  }
  return out;
}

const f = flags(process.argv.slice(2));

try {
  if (f.list) {
    const rows = listPlatformUsers();
    if (!rows.length) console.log('(no operators yet)');
    for (const r of rows) console.log(`${r.username.padEnd(24)} ${r.full_name ?? ''}`);
  } else if (f.username && f.password) {
    upsertPlatformUser(f.username, f.password, f.name && f.name !== 'true' ? f.name : undefined);
    console.log(`Operator "${f.username.toLowerCase()}" is ready. Sign in at /_platform.`);
  } else {
    console.error('Usage: platform:user -- --username <name> --password <pw> [--name "Full Name"]   |   --list');
    process.exit(1);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
