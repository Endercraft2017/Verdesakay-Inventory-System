/**
 * Tenant admin CLI (the control-plane UI until a /_platform page exists).
 *
 *   npm run tenant:create -- --slug acme --name "Acme Mfg" --admin owner --password s3cret [--plan starter]
 *   npm run tenant:list
 *   npm run tenant:status -- --slug acme --status suspended        (active|suspended|trial|past_due)
 *   npm run tenant:plan   -- --slug acme --plan operations         (trial|starter|operations|complete)
 *   npm run tenant:purge  -- --slug acme                           (deletes the tenant DB + uploads!)
 */
import { createTenant, purgeTenant } from '../src/provisioning';
import { listTenants, setTenantStatus, setTenantPlan, getTenant, type TenantStatus } from '../src/platform';
import { withTenant } from '../src/db';
import { tenantUsage, planFor } from '../src/quota';

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

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const [, , cmd, ...rest] = process.argv;
const f = flags(rest);

try {
  switch (cmd) {
    case 'create': {
      if (!f.slug || !f.name || !f.admin || !f.password) {
        die('Usage: tenant:create -- --slug <slug> --name <name> --admin <username> --password <pw> [--plan <plan>]');
      }
      const { slug } = createTenant({
        slug: f.slug, name: f.name, admin_username: f.admin, admin_password: f.password, plan: f.plan,
      });
      console.log(`Created tenant "${slug}". Admin login: ${f.admin.toLowerCase()}`);
      break;
    }
    case 'list': {
      const rows = listTenants();
      if (!rows.length) { console.log('(no tenants)'); break; }
      for (const t of rows) {
        console.log(`${t.slug.padEnd(24)} ${t.status.padEnd(10)} ${t.plan.padEnd(12)} ${t.name}`);
      }
      break;
    }
    case 'status': {
      if (!f.slug || !f.status) die('Usage: tenant:status -- --slug <slug> --status <active|suspended|trial|past_due>');
      if (!getTenant(f.slug)) die(`No such tenant: ${f.slug}`);
      const ok = setTenantStatus(f.slug, f.status as TenantStatus);
      console.log(ok ? `${f.slug} → ${f.status}` : 'No change (invalid status?)');
      break;
    }
    case 'plan': {
      if (!f.slug || !f.plan) die('Usage: tenant:plan -- --slug <slug> --plan <trial|starter|operations|complete>');
      if (!getTenant(f.slug)) die(`No such tenant: ${f.slug}`);
      console.log(setTenantPlan(f.slug, f.plan) ? `${f.slug} → plan ${f.plan}` : 'No change');
      break;
    }
    case 'usage': {
      if (!f.slug) die('Usage: tenant:usage -- --slug <slug>');
      if (!getTenant(f.slug)) die(`No such tenant: ${f.slug}`);
      const { plan, limits } = planFor(f.slug);
      const used = withTenant(f.slug, () => tenantUsage(f.slug));
      console.log(`${f.slug}  (plan: ${plan})`);
      for (const k of Object.keys(limits) as (keyof typeof limits)[]) {
        console.log(`  ${k.padEnd(16)} ${String(used[k]).padStart(8)} / ${limits[k]}`);
      }
      break;
    }
    case 'purge': {
      if (!f.slug) die('Usage: tenant:purge -- --slug <slug>');
      console.log(purgeTenant(f.slug) ? `Purged ${f.slug} (DB + uploads deleted).` : `No such tenant: ${f.slug}`);
      break;
    }
    default:
      die('Commands: create | list | status | plan | usage | purge');
  }
} catch (e) {
  die((e as Error).message);
}
