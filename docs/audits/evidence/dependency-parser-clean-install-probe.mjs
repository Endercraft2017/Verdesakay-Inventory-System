import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const [install, source, mode] = process.argv.slice(2);
const rootRequire = createRequire(path.resolve(install, 'package.json'));
const localRequire = createRequire(rootRequire.resolve('mammoth'));
const parser = localRequire('argparse/package.json');
const lock = JSON.parse(fs.readFileSync(path.join(install, 'package-lock.json'), 'utf8'));
const formatters = Object.entries(lock.packages).filter(([name, entry]) =>
  name.endsWith('/sprintf-js') && !entry.dev).map(([name, entry]) => ({ name, version: entry.version }));
const result = { mode, mammoth: localRequire('mammoth/package.json').version,
  parser: parser.version, parserDependencies: parser.dependencies || {}, runtimeFormatters: formatters };
if (parser.dependencies?.['sprintf-js']) {
  const parserRequire = createRequire(localRequire.resolve('argparse'));
  try { parserRequire('sprintf-js').sprintf('%.101f', 1); result.precisionProbe = 'returned'; }
  catch (error) { result.precisionProbe = { name: error.name, message: error.message }; }
}
const mammoth = localRequire('mammoth');
const buffer = fs.readFileSync(source);
const html = await mammoth.convertToHtml({ buffer }, { externalFileAccess: false, includeEmbeddedStyleMap: false });
const text = await mammoth.extractRawText({ buffer });
assert(html.value.includes('<h1>Clean install document</h1>'));
assert(text.value.includes('Independent café 🌱'));
const cli = spawnSync(process.execPath, [rootRequire.resolve('mammoth/bin/mammoth'), source], {
  encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
});
assert.ifError(cli.error);
assert.equal(cli.status, 0);
assert(cli.stdout.includes('<h1>Clean install document</h1>'));
result.apiHtml = 'passed'; result.apiText = 'passed'; result.cli = 'passed';
if (mode === 'before') { assert.equal(formatters.length, 1); assert.equal(result.precisionProbe?.name, 'RangeError'); }
else { assert.equal(formatters.length, 0); assert(!parser.dependencies?.['sprintf-js']); }
console.log(JSON.stringify(result, null, 2));
