import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inventory, isPublicPath, publicFiles } from '../scripts/package-files.js';

test('standalone inventory includes implementation and pinned engine inputs and rejects generated or private material', () => {
  const root = mkdtempSync(join(tmpdir(), 'jovault-standalone-'));
  const included = [
    'README.md',
    'src/index.ts',
    'engine-probe/Cargo.lock',
    'engine-probe/audit/Cargo.lock',
    'engine-probe/patches/boa_engine-0.22.0.patch',
    'engine-probe/conformance/LICENSE.test262',
    'assets/jovm-mark.svg',
    'assets/jovm-mark-light.svg',
  ];
  const excluded = [
    'private/notes.md',
    'src/key.pem',
    'demo/config.local.json',
    'engine-probe/target/result.rs',
    'engine-probe/evidence/report.json',
    'engine-probe/patches/vendor-budget/boa_engine/src/lib.rs',
    'engine-probe/patches/crate-cache/package.crate',
    'engine-probe/results.json',
    'node_modules/package/index.js',
  ];
  try {
    for (const name of [...included, ...excluded]) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), 'fixture\n');
    }
    assert.deepEqual(publicFiles(root), [...included].sort());
    assert.ok(
      inventory(root).every(
        (entry) =>
          entry.bytes === Buffer.byteLength('fixture\n') && /^[a-f0-9]{64}$/u.test(entry.sha256),
      ),
    );
    for (const name of [
      '../README.md',
      '/README.md',
      'src/../README.md',
      'src/note.md:stream',
      'src\\note.md',
    ])
      assert.equal(isPublicPath(name), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone inventory refuses links within selected source roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'jovault-standalone-'));
  const outside = mkdtempSync(join(tmpdir(), 'jovault-outside-'));
  mkdirSync(join(root, 'src'));
  symlinkSync(
    outside,
    join(root, 'src', 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  try {
    assert.throws(() => publicFiles(root), /PACKAGE_SYMLINK/u);
  } finally {
    unlinkSync(join(root, 'src', 'linked'));
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('exported origin records every source copy and the unchanged helper and brand bytes', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const origin = JSON.parse(readFileSync(join(root, 'ORIGIN.json'), 'utf8')) as {
    files: { destination: string; destinationSha256: string }[];
    generated: { destination: string; destinationSha256: string }[];
    exclusions: { source: string }[];
  };
  const actual = new Map(inventory(root).map((entry) => [entry.path, entry.sha256]));
  for (const entry of origin.files)
    assert.equal(actual.get(entry.destination), entry.destinationSha256, entry.destination);
  for (const entry of origin.generated)
    assert.equal(actual.get(entry.destination), entry.destinationSha256, entry.destination);
  assert.deepEqual(
    [...actual.keys()].filter((name) => name !== 'ORIGIN.json').sort(),
    [...origin.files, ...origin.generated].map((entry) => entry.destination).sort(),
  );
  assert.ok(origin.exclusions.some((entry) => entry.source.endsWith('/tests/repository.test.ts')));
  assert.ok(origin.files.some((entry) => entry.destination === 'src/random.ts'));
  assert.ok(origin.files.some((entry) => entry.destination === 'assets/jovm-mark.svg'));
  assert.ok(origin.files.some((entry) => entry.destination === 'assets/jovm-mark-light.svg'));
});
