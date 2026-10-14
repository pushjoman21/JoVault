import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildModule } from '../src/cli.js';

test('CLI builder preserves relative host resolution and hashes the actual outputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jovault-cli-'));
  try {
    const source = join(directory, 'algorithm.mjs');
    const dependency = join(directory, 'host.mjs');
    const output = join(directory, 'new-build');
    writeFileSync(dependency, 'export function add(x) { return x + 4; }\n');
    writeFileSync(
      source,
      'import { add } from "./host.mjs"; export function main(x) { return add(x) * 2; }\n',
    );
    const before = readFileSync(source, 'utf8');
    await buildModule(source, output);
    const generated = await import(pathToFileURL(join(output, 'module.mjs')).href);
    assert.equal(generated.main(5), 18);
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as {
      files: { path: string; sha256: string; bytes: number }[];
    };
    for (const file of manifest.files) {
      const bytes = readFileSync(join(output, file.path));
      assert.equal(file.bytes, bytes.length);
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
    await assert.rejects(buildModule(source, output), /EEXIST/);
    assert.equal(readFileSync(source, 'utf8'), before);
    assert.equal(readFileSync(dependency, 'utf8'), 'export function add(x) { return x + 4; }\n');
  } finally {
    rmSync(directory, { recursive: true });
  }
});
