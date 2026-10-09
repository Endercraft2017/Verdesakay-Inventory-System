import { adoptDefaultTenant } from '../src/platform/adopt-default';

const args = process.argv.slice(2);
function value(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}
try {
  const slug = value('--slug');
  const name = value('--name');
  if (!slug || !name) throw new Error('Usage: npx tsx scripts/adopt-default-tenant.ts --slug verdesakay --name Verdesakay [--apply --server-stopped]');
  console.log(JSON.stringify(adoptDefaultTenant({ slug, name, plan: value('--plan'), apply: args.includes('--apply'), serverStopped: args.includes('--server-stopped') }), null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
