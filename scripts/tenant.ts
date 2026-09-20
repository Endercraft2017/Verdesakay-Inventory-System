/**
 * Tenant admin CLI (the control-plane UI until a /_platform page exists).
 *
 *   npm run tenant:create -- --slug acme --name "Acme Mfg" --admin owner --password s3cret [--plan starter]
 *   npm run tenant:list
 *   npm run tenant:status -- --slug acme --status suspended        (active|suspended|trial|past_due)
 *   npm run tenant:plan   -- --slug acme --plan operations         (trial|starter|operations|complete)
 *   npm run tenant:modules -- --slug acme                          (show enabled feature modules)
 *   npm run tenant:modules -- --slug acme --set inventory,hr       (explicit override; deps auto-added)
 *   npm run tenant:modules -- --slug acme --add ai --remove email  (delta on the current set)
 *   npm run tenant:modules -- --slug acme --reset                  (clear override → plan default)
 *   npm run tenant:purge  -- --slug acme                           (deletes the tenant DB + uploads!)
 */
import { createTenant, purgeTenant } from '../src/provisioning';
import {
  listTenants, setTenantStatus, setTenantPlan, setTenantModules, getTenant, type TenantStatus,
} from '../src/platform';
import { withTenant } from '../src/db';
import { tenantUsage, planFor } from '../src/quota';
import { MODULES, enabledModules, withDeps } from '../src/modules';

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
    case 'modules': {
      if (!f.slug) die('Usage: tenant:modules -- --slug <slug> [--set a,b,c | --add x --remove y | --reset]');
      const t = getTenant(f.slug);
      if (!t) die(`No such tenant: ${f.slug}`);

      const known = new Set<string>(MODULES as readonly string[]);
      const parseList = (s: string) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      const checkKnown = (list: string[]) => {
        const bad = list.filter((m) => !known.has(m));
        if (bad.length) die(`Unknown module(s): ${bad.join(', ')}. Known: ${[...MODULES].join(', ')}`);
      };

      if (f.reset) {
        setTenantModules(f.slug, null);
        console.log(`${f.slug} → module override cleared (now using the "${t.plan}" plan default).`);
        break;
      }

      const hasSet = typeof f.set === 'string' && f.set !== 'true';
      const hasDelta = (typeof f.add === 'string' && f.add !== 'true') || (typeof f.remove === 'string' && f.remove !== 'true');
      if (hasSet && hasDelta) die('Use either --set, or --add/--remove — not both.');

      if (hasSet || hasDelta) {
        let desired: Set<string>;
        if (hasSet) {
          const list = parseList(f.set);
          checkKnown(list);
          desired = new Set(list);
        } else {
          desired = new Set<string>(enabledModules(f.slug)); // current effective set
          const add = f.add && f.add !== 'true' ? parseList(f.add) : [];
          const remove = f.remove && f.remove !== 'true' ? parseList(f.remove) : [];
          checkKnown([...add, ...remove]);
          add.forEach((m) => desired.add(m));
          remove.forEach((m) => desired.delete(m));
          for (const m of remove) {
            if ((withDeps(desired) as string[]).includes(m)) {
              die(`Can't remove "${m}" — another enabled module depends on it. Remove that one too.`);
            }
          }
        }
        const finalList = withDeps(desired);
        const autoAdded = finalList.filter((m) => !desired.has(m));
        setTenantModules(f.slug, finalList);
        console.log(`${f.slug} → modules: ${finalList.join(', ') || '(none)'}`);
        if (autoAdded.length) console.log(`  (added required dependency: ${autoAdded.join(', ')})`);
        break;
      }

      const eff = [...enabledModules(f.slug)];
      console.log(`${f.slug}  (source: ${t.modules ? 'per-tenant override' : `"${t.plan}" plan default`})`);
      console.log(`  enabled : ${eff.join(', ') || '(none)'}`);
      console.log(`  disabled: ${(MODULES as readonly string[]).filter((m) => !eff.includes(m)).join(', ') || '(none)'}`);
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
      die('Commands: create | list | status | plan | modules | usage | purge');
  }
} catch (e) {
  die((e as Error).message);
}
