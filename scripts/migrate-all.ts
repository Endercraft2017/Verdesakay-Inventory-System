/**
 * Deploy-time migration runner. Opens every tenant DB (the `default` tenant + every
 * non-purged catalog entry) and runs createSchema() + migrate() against it, so a new
 * release's schema changes are applied up front instead of by the first unlucky request.
 *
 *   npm run migrate:all
 */
import { forceMigrate, SCHEMA_VERSION, DEFAULT_TENANT } from '../src/shared/db';
import { listTenants } from '../src/platform/platform';

const slugs = [
  DEFAULT_TENANT,
  ...listTenants().filter((t) => t.status !== 'purged').map((t) => t.slug),
];

console.log(`Migrating ${slugs.length} tenant DB(s) to schema v${SCHEMA_VERSION}…`);
let ok = 0;
for (const slug of slugs) {
  try {
    forceMigrate(slug);
    console.log(`  ✓ ${slug}`);
    ok++;
  } catch (e) {
    console.error(`  ✗ ${slug}: ${(e as Error).message}`);
  }
}
console.log(`Done — ${ok}/${slugs.length} migrated.`);
process.exit(ok === slugs.length ? 0 : 1);
