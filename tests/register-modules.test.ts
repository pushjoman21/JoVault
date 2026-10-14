import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compileModule, emitModule } from '../src/register-compiler.js';

type NativeModule = Record<string, (...args: unknown[]) => unknown>;

async function withModules(
  source: string,
  check: (native: NativeModule, vaulted: NativeModule, directory: string) => Promise<void> | void,
  hostSource?: string,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'jovault-register-module-'));
  try {
    await build({
      entryPoints: [fileURLToPath(new URL('../src/register-runtime.ts', import.meta.url))],
      outfile: path.join(directory, 'jovault-runtime.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      logLevel: 'silent',
    });
    if (hostSource !== undefined) await writeFile(path.join(directory, 'host.mjs'), hostSource);
    await writeFile(path.join(directory, 'native.mjs'), source);
    const compilation = compileModule(source, {
      now: Date.now(),
      variant: 'register-native-parity',
    });
    await writeFile(path.join(directory, 'vaulted.mjs'), emitModule(compilation));
    const native = (await import(
      pathToFileURL(path.join(directory, 'native.mjs')).href
    )) as NativeModule;
    const vaulted = (await import(
      pathToFileURL(path.join(directory, 'vaulted.mjs')).href
    )) as NativeModule;
    await check(native, vaulted, directory);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('jovault-register-module-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('register wrappers match native ESM for 31 scalar semantic cases', async () => {
  const expressions = [
    '-0',
    '0/0',
    '1/0',
    '-1/0',
    'NaN',
    'Infinity',
    'undefined',
    'null',
    '"value:"+2+3',
    '2+3+"value"',
    '+"12"+1',
    '-"12"',
    '17%5',
    '-17%5',
    '2**5',
    '~0',
    '4294967295|0',
    '-1>>>1',
    '8>>2',
    '1<<33',
    '6&3',
    '6^3',
    'NaN===NaN',
    'NaN!==NaN',
    '-0===0',
    '"2"===2',
    '"10"<"2"',
    '"10"<2',
    '3<=3&&4>=3&&4>3',
    'false||"right"',
    '"left"&&7',
  ];
  assert.equal(expressions.length, 31);
  const source = expressions
    .map((expression, index) => `export function case${index}(){return ${expression};}`)
    .join('\n');
  await withModules(source, (native, vaulted) => {
    assert.deepEqual(Object.keys(vaulted).sort(), Object.keys(native).sort());
    for (const name of Object.keys(native))
      assert.ok(Object.is(vaulted[name]!(), native[name]!()), name);
  });
});

test('register ESM preserves alias identity, relative imports, live host bindings and call order', async () => {
  const source = `import offset, { mark as record } from './host.mjs';
    function helper(x) { return record(x+offset(2)); }
    export default function main(x) { return helper(x); }
    export { main as alias };
    export function twice(x) { return helper(x)*2; }`;
  await withModules(
    source,
    async (native, vaulted, directory) => {
      assert.deepEqual(Object.keys(vaulted).sort(), Object.keys(native).sort());
      assert.equal(vaulted.default, vaulted.alias);
      const host = (await import(pathToFileURL(path.join(directory, 'host.mjs')).href)) as {
        reset(): void;
        mode(value: number): void;
        observed(): unknown[];
      };
      for (const mode of [0, 7]) {
        host.mode(mode);
        for (const name of Object.keys(native)) {
          host.reset();
          const expected = native[name]!(5);
          const seen = host.observed();
          host.reset();
          assert.equal(vaulted[name]!(5), expected, `${name}, mode ${mode}`);
          assert.deepEqual(host.observed(), seen);
        }
      }
    },
    `let calls=[]; let offset=(x)=>{calls.push('initial:'+x);return x+1;};
    export { offset as default };
    export let mark=(x)=>{calls.push('mark:'+x);return x;};
    export function mode(n){offset=(x)=>{calls.push('offset:'+x);return x+n;};mark=(x)=>{calls.push('mark:'+x);return x+n;};}
    export function reset(){calls=[];}
    export function observed(){return [...calls];}`,
  );
});

test('register VM has native parity for one-line branches and a module over 2100 lines', async () => {
  await withModules(
    'export function main(x,y){let n=x+y;if(n){n=n*2;}else{n=-0;}return n;}',
    (native, vaulted) => {
      for (const args of [
        [2, 3],
        [0, 0],
        [NaN, 1],
        [Infinity, -Infinity],
        ['x', 2],
        ['', 0],
      ])
        assert.ok(Object.is(vaulted.main!(...args), native.main!(...args)));
    },
  );
  const lines = ['export function main(input) {', 'let result=input;'];
  for (let index = 0; index < 2105; index++) lines.push(`result+=${index % 7};`);
  lines.push('return result;', '}');
  assert.ok(lines.length > 2100);
  await withModules(lines.join('\n'), (native, vaulted) => {
    for (const input of [-15, 0, 123, 'prefix:'])
      assert.ok(Object.is(vaulted.main!(input), native.main!(input)), String(input));
  });
});
