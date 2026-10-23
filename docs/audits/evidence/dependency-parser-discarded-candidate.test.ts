/**
 * Contract for the narrowly overridden Mammoth CLI parser. Expected conversions
 * follow Mammoth's public CLI/API contract, not the parser's internal API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import mammoth from 'mammoth';

const require = createRequire(import.meta.url);
const mammothRequire = createRequire(require.resolve('mammoth'));
const cli = require.resolve('mammoth/bin/mammoth');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
let dir: string;
let source: string;
let buffer: Buffer;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-mammoth-compat-'));
  source = path.join(dir, 'Word source with spaces.docx');
  buffer = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ text: 'Compatibility heading', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun('Unicode café 🌱 & '), new TextRun({ text: 'bold text', bold: true })] }),
    new Paragraph({ children: [new ImageRun({ type: 'png', data: pixel, transformation: { width: 1, height: 1 } })] }),
  ] }] }));
  fs.writeFileSync(source, buffer);
});
afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function run(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

describe('Mammoth dependency security contract', () => {
  it('does not install the advisory-affected formatter on the Mammoth parser path', () => {
    const parser = mammothRequire('argparse/package.json');
    expect(parser.dependencies || {}).not.toHaveProperty('sprintf-js');
    // Node can resolve unrelated development/OS-global packages. Check the
    // shipped production graph, not all ambient resolution candidates.
    const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const formatters = Object.entries(lock.packages).filter(([name, entry]) =>
      name.endsWith('/sprintf-js') && !(entry as { dev?: boolean }).dev);
    expect(formatters).toEqual([]);
  });
});

describe('Mammoth public CLI compatibility', () => {
  it('offers help without requiring a document', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    for (const flag of ['--output-dir', '--output-format', '--style-map']) expect(result.stdout).toContain(flag);
  });

  it('converts a positional path with spaces to UTF-8 HTML on stdout', () => {
    const result = run([source]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('<h1>Compatibility heading</h1>');
    expect(result.stdout).toContain('Unicode café 🌱 &amp; <strong>bold text</strong>');
    expect(result.stdout).toContain('data:image/png;base64,');
  });

  it('writes a positional output file instead of conversion text on stdout', () => {
    const output = path.join(dir, 'Output with spaces.html');
    const result = run([source, output]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.readFileSync(output, 'utf8')).toContain('<h1>Compatibility heading</h1>');
  });

  it('honors both style-map and output-format options', () => {
    const styles = path.join(dir, 'Custom style map.txt');
    fs.writeFileSync(styles, "p[style-name='Heading 1'] => h2:fresh\n");
    const html = run(['--style-map', styles, source]);
    expect(html.status).toBe(0);
    expect(html.stdout).toContain('<h2>Compatibility heading</h2>');
    const markdown = run([source, '--output-format=markdown']);
    expect(markdown.status).toBe(0);
    expect(markdown.stdout).toContain('# Compatibility heading');
    expect(markdown.stdout).toMatch(/(?:\*\*bold text\*\*|__bold text__)/);
  });

  it('writes separately referenced image bytes to the requested output directory', () => {
    const output = path.join(dir, 'Output directory');
    fs.mkdirSync(output);
    const result = run([source, '--output-dir', output]);
    expect(result.status).toBe(0);
    const html = fs.readFileSync(path.join(output, 'Word source with spaces.html'), 'utf8');
    expect(html).toContain('src="1.png"');
    expect(fs.readFileSync(path.join(output, '1.png'))).toEqual(pixel);
  });

  it.each([
    { name: 'missing document', args: () => [], expected: /required|too few/i },
    { name: 'invalid format', args: () => [source, '--output-format', 'pdf'], expected: /invalid choice/i },
    { name: 'mutually exclusive destinations', args: () => [source, path.join(dir, 'conflicting.html'), '--output-dir', dir], expected: /not allowed/i },
  ])('rejects $name with a usage error rather than converting', ({ args, expected }) => {
    const result = run(args());
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('Compatibility heading');
    expect(result.stderr).toMatch(expected);
    expect(fs.existsSync(path.join(dir, 'conflicting.html'))).toBe(false);
  });
});

it('preserves the application-facing raw-text and HTML library contracts', async () => {
  const html = await mammoth.convertToHtml({ buffer }, { externalFileAccess: false, includeEmbeddedStyleMap: false });
  expect(html.value).toContain('<h1>Compatibility heading</h1>');
  expect(html.value).toContain('<strong>bold text</strong>');
  const text = await mammoth.extractRawText({ buffer });
  expect(text.value).toContain('Compatibility heading\n\nUnicode café 🌱 & bold text');
  expect(text.value).not.toContain('<h1>');
});
