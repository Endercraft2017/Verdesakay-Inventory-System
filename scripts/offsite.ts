/**
 * Off-site backup CLI — see src/platform/offsite.ts. Needs the same BACKUP_S3_* / BACKUP_KEY
 * env as the server (on Railway: run it in the service shell, `railway ssh`).
 *
 *   npm run backup:offsite -- test                          round-trip a test file through every target
 *   npm run backup:offsite -- push                          send everything new now
 *   npm run backup:offsite -- list <target> [prefix]        list objects, e.g. db/verdesakay/
 *   npm run backup:offsite -- fetch <target> <key> <out>    download + decrypt one object
 *   npm run backup:offsite -- fetch-uploads <target> <dir>  download + decrypt every uploads/ file into <dir>
 *
 * Restoring a database: fetch its snapshot to a .db file, then
 *   npm run backup:restore -- <name> <that file> --yes      (server stopped)
 */
import fs from 'node:fs';
import path from 'node:path';
import { offsiteTargets, findTarget, pushOffsite, testTarget, unpack } from '../src/platform/offsite';

const [cmd = 'help', ...args] = process.argv.slice(2);

function mb(n: number): string { return `${(n / 1024 / 1024).toFixed(2)} MB`; }

async function main(): Promise<void> {
  switch (cmd) {
    case 'test': {
      const targets = offsiteTargets();
      if (!targets.length) throw new Error('No targets configured (set BACKUP_S3_<NAME>_BUCKET and friends).');
      let failed = 0;
      for (const t of targets) {
        try { await testTarget(t); console.log(`✔ ${t.name}: upload, download and decrypt OK`); }
        catch (e) { failed++; console.error(`✘ ${t.name}: ${(e as Error).message}`); }
      }
      if (failed) process.exit(1);
      break;
    }
    case 'push': {
      const results = await pushOffsite();
      if (!results.length) console.log('No off-site targets configured.');
      for (const r of results) {
        console.log(r.ok
          ? `✔ ${r.target}: ${r.dbSent} snapshot(s), ${r.uploadsSent} upload(s) sent, ${r.pruned} snapshot(s) pruned, ${r.photosRemoved} expired punch photo(s) removed`
          : `✘ ${r.target}: ${r.error}`);
      }
      if (results.some((r) => !r.ok)) process.exit(1);
      break;
    }
    case 'list': {
      const [target, prefix = ''] = args;
      if (!target) throw new Error('Usage: list <target> [prefix]');
      const objs = await findTarget(target).client.list(prefix);
      for (const o of objs.sort((a, b) => a.key.localeCompare(b.key))) {
        console.log(`${o.lastModified.slice(0, 19).replace('T', ' ')}  ${mb(o.size).padStart(10)}  ${o.key}`);
      }
      console.log(`${objs.length} object(s)`);
      break;
    }
    case 'fetch': {
      const [target, key, out] = args;
      if (!target || !key || !out) throw new Error('Usage: fetch <target> <key> <output-file>');
      const data = unpack(await findTarget(target).client.get(key));
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, data);
      console.log(`Wrote ${out} (${mb(data.length)})`);
      break;
    }
    case 'fetch-uploads': {
      const [target, dir] = args;
      if (!target || !dir) throw new Error('Usage: fetch-uploads <target> <destination-dir>');
      const t = findTarget(target);
      const objs = await t.client.list('uploads/');
      for (const o of objs) {
        const rel = o.key.slice('uploads/'.length).replace(/\.gz\.enc$/, '');
        const dest = path.join(dir, ...rel.split('/'));
        if (!path.resolve(dest).startsWith(path.resolve(dir))) continue; // never write outside dir
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, unpack(await t.client.get(o.key)));
      }
      console.log(`Restored ${objs.length} file(s) into ${dir}`);
      break;
    }
    default:
      console.log('Usage: npm run backup:offsite -- test | push | list <target> [prefix] | fetch <target> <key> <out> | fetch-uploads <target> <dir>');
  }
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
