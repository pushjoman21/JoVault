import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compileModule, emitModule } from '../src/frontend.js';

type NativeModule = Record<string, (...args: unknown[]) => unknown>;

async function withModules(
  source: string,
  check: (native: NativeModule, vaulted: NativeModule, directory: string) => Promise<void> | void,
  hostSource?: string,
  runtimeFilename: 'jovault-runtime.mjs' | 'custom-runtime.mjs' = 'jovault-runtime.mjs',
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'jovault-module-'));
  try {
    const runtimePath = path.join(directory, runtimeFilename);
    await build({
      entryPoints: [fileURLToPath(new URL('./reference-runtime.ts', import.meta.url))],
      outfile: runtimePath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      logLevel: 'silent',
    });
    if (hostSource !== undefined) await writeFile(path.join(directory, 'host.mjs'), hostSource);
    await writeFile(path.join(directory, 'native.mjs'), source);
    const compilation = compileModule(source, { now: Date.now(), variant: 'module-acceptance' });
    await writeFile(
      path.join(directory, 'vaulted.mjs'),
      runtimeFilename === 'jovault-runtime.mjs'
        ? emitModule(compilation)
        : emitModule(compilation, `./${runtimeFilename}`),
    );
    const native = (await import(
      pathToFileURL(path.join(directory, 'native.mjs')).href
    )) as NativeModule;
    const vaulted = (await import(
      pathToFileURL(path.join(directory, 'vaulted.mjs')).href
    )) as NativeModule;
    await check(native, vaulted, directory);
  } finally {
    // Only this fresh, literal-prefix temporary directory is owned by the test.
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('jovault-module-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('emitted ESM preserves relative named/default imports and named/default/aliased exports', async () => {
  const source = `import offset, { mark as record } from './host.mjs';
    function helper(x) { return record(x + offset(2)); }
    export default function main(x) { return helper(x); }
    export function double(x) { return helper(x) * 2; }
    export { helper as alias, main as namedDefault };`;
  await withModules(
    source,
    async (native, vaulted, directory) => {
      assert.deepEqual(Object.keys(vaulted).sort(), Object.keys(native).sort());
      assert.equal(native.default, native.namedDefault);
      assert.equal(
        vaulted.default,
        vaulted.namedDefault,
        'aliases must share one exported wrapper',
      );
      const host = (await import(pathToFileURL(path.join(directory, 'host.mjs')).href)) as {
        reset(): void;
        observed(): unknown[];
      };
      for (const name of Object.keys(native)) {
        host.reset();
        const expected = native[name]!(5);
        const expectedCalls = host.observed();
        host.reset();
        assert.equal(vaulted[name]!(5), expected, name);
        assert.deepEqual(host.observed(), expectedCalls, name);
      }
    },
    `const calls = [];
      export default function offset(x) { calls.push('offset:' + x); return x + 3; }
      export function mark(x) { calls.push('mark:' + x); return x; }
      export function reset() { calls.length = 0; }
      export function observed() { return [...calls]; }`,
  );
});

test('anonymous default function and an alternate runtime specifier produce importable ESM', async () => {
  await withModules('export default function (x) { return x * 3; }', (native, vaulted) => {
    assert.equal(vaulted.default!(7), native.default!(7));
  });
  await withModules(
    'export function run(x) { return x + 1; }',
    (native, vaulted) => assert.equal(vaulted.run!(8), native.run!(8)),
    undefined,
    'custom-runtime.mjs',
  );
});

test('one-line source has real native ESM parity including scalar edge cases', async () => {
  const source = 'export function main(x,y){let n=x+y;if(n){n=n*2;}else{n=-0;}return n;}';
  await withModules(source, (native, vaulted) => {
    for (const args of [
      [2, 3],
      [0, 0],
      [NaN, 1],
      [Infinity, -Infinity],
      ['x', 2],
      ['', 0],
    ]) {
      assert.ok(Object.is(vaulted.main!(...args), native.main!(...args)), JSON.stringify(args));
    }
  });
});

test('a generated module over 2000 lines has actual native ESM parity', async () => {
  const lines = ['export function main(input) {', '  let result = input;'];
  for (let i = 0; i < 2105; i++) lines.push(`  result += ${i % 7};`);
  lines.push('  return result;', '}');
  const source = lines.join('\n');
  assert.ok(source.split('\n').length > 2000);
  await withModules(source, (native, vaulted) => {
    for (const input of [-15, 0, 123, 'prefix:']) {
      assert.ok(Object.is(vaulted.main!(input), native.main!(input)), String(input));
    }
  });
});

test('serialized wrappers retain NaN, Infinity and negative zero constants', async () => {
  const source = `export function negativeZero() { return -0; }
    export function nan() { return NaN; }
    export function positiveInfinity() { return Infinity; }
    export function negativeInfinity() { return -Infinity; }`;
  await withModules(source, (native, vaulted) => {
    for (const name of Object.keys(native))
      assert.ok(Object.is(vaulted[name]!(), native[name]!()), name);
  });
});
