import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOA_COMPILER_LIMITS,
  BoaCompilerError,
  compileBoaCheckpoint,
  snapshotBoaCompilerGraph,
  snapshotExportNames,
} from '../src/boa-compiler-node.js';
import type { TrustedBoaRuntime } from '../src/boa-checkpoint.js';

const input = (source = 'export function main() { return 42; }') => ({
  entry: '/main.mjs',
  modules: [{ id: '/main.mjs', source }],
});

function rejects(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof BoaCompilerError);
    assert.equal(error.code, code);
    assert.equal(error.message, code, 'compiler failures must not echo source');
    return true;
  };
}

test('compiler graph snapshots exact source and immutable explicit modules', () => {
  const source = '\ufeff// 雪😀\r\nexport const main = () => "\\ud800";\r\n';
  const original = input(source);
  const result = snapshotBoaCompilerGraph(original);
  original.modules[0]!.source = 'changed';
  original.modules.push({ id: '/extra.mjs', source: '' });
  assert.equal(result.modules[0]!.source, source);
  assert.equal(result.modules.length, 1);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.modules));
  assert.ok(Object.isFrozen(result.modules[0]));
});

test('compiler graph rejects missing, duplicated or aliased identities', () => {
  for (const invalid of [
    null,
    {},
    { ...input(), extra: true },
    { ...input(), entry: '/missing.mjs' },
    { ...input(), modules: [] },
    { ...input(), modules: [input().modules[0], input().modules[0]] },
    ...[
      'main.mjs',
      '//main.mjs',
      '/a/../main.mjs',
      '/./main.mjs',
      '/x?.mjs',
      '/雪.mjs',
      '/a\\b.mjs',
    ].map((entry) => ({ entry, modules: [{ id: entry, source: '' }] })),
  ])
    assert.throws(() => snapshotBoaCompilerGraph(invalid), rejects('BOA_COMPILER_INPUT'));
});

test('compiler graph rejects accessors without reading them', () => {
  let reads = 0;
  const accessor = {
    entry: '/main.mjs',
    get modules() {
      reads++;
      return input().modules;
    },
  };
  const list = new Array<unknown>(1);
  Object.defineProperty(list, '0', {
    enumerable: true,
    get() {
      reads++;
      return input().modules[0];
    },
  });
  assert.throws(() => snapshotBoaCompilerGraph(accessor), rejects('BOA_COMPILER_INPUT'));
  assert.throws(
    () => snapshotBoaCompilerGraph({ entry: '/main.mjs', modules: list }),
    rejects('BOA_COMPILER_INPUT'),
  );
  assert.equal(reads, 0);
});

test('compiler graph rejects sparse arrays, array properties and inherited records', () => {
  const sparse = new Array<unknown>(1);
  const decorated = Object.assign(input().modules, { extra: true });
  const inherited = Object.assign(Object.create({ inherited: true }) as object, input());
  for (const invalid of [
    { entry: '/main.mjs', modules: sparse },
    { entry: '/main.mjs', modules: decorated },
    inherited,
    { ...input(), modules: [{ ...input().modules[0], kind: 'javascript' }] },
  ])
    assert.throws(() => snapshotBoaCompilerGraph(invalid), rejects('BOA_COMPILER_INPUT'));
});

test('compiler validates byte budgets before creating a worker', async () => {
  assert.throws(
    () => snapshotBoaCompilerGraph(input('雪'.repeat(BOA_COMPILER_LIMITS.moduleBytes / 3 + 1))),
    rejects('BOA_COMPILER_SIZE'),
  );
  assert.throws(
    () => snapshotBoaCompilerGraph(input('x'.repeat(BOA_COMPILER_LIMITS.moduleBytes + 1))),
    rejects('BOA_COMPILER_SIZE'),
  );
  const large = 'x'.repeat(BOA_COMPILER_LIMITS.moduleBytes);
  const modules = Array.from({ length: 9 }, (_, index) => ({ id: `/${index}.mjs`, source: large }));
  await assert.rejects(
    compileBoaCheckpoint({ entry: '/0.mjs', modules }, {} as TrustedBoaRuntime),
    rejects('BOA_COMPILER_SIZE'),
  );
  assert.throws(
    () =>
      snapshotBoaCompilerGraph({
        entry: '/0.mjs',
        modules: Array.from({ length: 129 }, (_, index) => ({ id: `/${index}.mjs`, source: '' })),
      }),
    rejects('BOA_COMPILER_INPUT'),
  );
});

test('compiler rejects lone surrogate source without replacing source text', () => {
  for (const source of ['\ud800', '\udfff', 'x\ud800x'])
    assert.throws(() => snapshotBoaCompilerGraph(input(source)), rejects('BOA_COMPILER_INPUT'));
  assert.equal(snapshotBoaCompilerGraph(input('😀')).modules[0]!.source, '😀');
});

test('caller supplied audit-like objects cannot substitute for a trusted runtime', async () => {
  await assert.rejects(
    compileBoaCheckpoint(input(), {
      runtimeSha256: '0'.repeat(64),
      auditSha256: '0'.repeat(64),
      checkpointStateGatePassed: true,
    } as unknown as TrustedBoaRuntime),
    rejects('BOA_COMPILER_PROFILE'),
  );
});

test('export metadata is bounded data without binding access', () => {
  const names = ['default', 'main', '雪😀', '\ud800'];
  const result = snapshotExportNames(names);
  names[0] = 'mutated';
  assert.deepEqual(result, ['default', 'main', '雪😀', '\ud800']);
  assert.ok(Object.isFrozen(result));
  for (const invalid of [
    ['main', 'main'],
    [1],
    ['x'.repeat(8193)],
    Array.from({ length: 257 }, (_, index) => String(index)),
    new Array<unknown>(1),
    {},
  ])
    assert.throws(() => snapshotExportNames(invalid), rejects('BOA_COMPILER_ABI'));
});
