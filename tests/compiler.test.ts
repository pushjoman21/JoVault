import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule } from '../src/frontend.js';
import { EPOCH_MS, type HostFunction, type Value } from '../src/ir.js';
import { instantiate } from './reference-runtime.js';

const NOW = 1_800_123;

function execute(source: string, args: Value[] = [], hosts: HostFunction[] = []): Value {
  const { artifact, dialect } = compileModule(source, { now: NOW, variant: 'acceptance' });
  return instantiate(artifact, dialect, hosts, { now: () => NOW }).invoke('main', args);
}

function rejectsSource(source: string): void {
  assert.throws(
    () => compileModule(source, { now: NOW, filename: 'rejected.js' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'CompileError');
      const diagnostic = error as Error & {
        code?: unknown;
        line?: unknown;
        column?: unknown;
        location?: { line?: unknown; column?: unknown };
      };
      assert.equal(typeof diagnostic.code, 'string');
      assert.ok((diagnostic.code as string).length > 0);
      const line = diagnostic.line ?? diagnostic.location?.line;
      const column = diagnostic.column ?? diagnostic.location?.column;
      assert.equal(typeof line, 'number');
      assert.equal(typeof column, 'number');
      assert.ok((line as number) >= 1);
      assert.ok((column as number) >= 0);
      return true;
    },
    source,
  );
}

test('scalar arithmetic retains JavaScript number and string behavior', () => {
  const cases: [string, Value][] = [
    ['-0', -0],
    ['0 / 0', NaN],
    ['1 / 0', Infinity],
    ['-1 / 0', -Infinity],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['undefined', undefined],
    ['null', null],
    ['"value:" + 2 + 3', 'value:23'],
    ['2 + 3 + "value"', '5value'],
    ['+"12" + 1', 13],
    ['-"12"', -12],
    ['17 % 5', 2],
    ['-17 % 5', -2],
    ['2 ** 5', 32],
    ['~0', -1],
    ['4294967295 | 0', -1],
    ['-1 >>> 1', 2147483647],
    ['8 >> 2', 2],
    ['1 << 33', 2],
    ['6 & 3', 2],
    ['6 ^ 3', 5],
    ['NaN === NaN', false],
    ['NaN !== NaN', true],
    ['-0 === 0', true],
    ['"2" === 2', false],
    ['"10" < "2"', true],
    ['"10" < 2', false],
    ['3 <= 3 && 4 >= 3 && 4 > 3', true],
  ];
  for (const [expression, expected] of cases) {
    const actual = execute(`export function main() { return ${expression}; }`);
    assert.ok(Object.is(actual, expected), `${expression}: ${String(actual)}`);
  }
});

test('logical and conditional expressions preserve values and truthiness', () => {
  const values: Value[] = [undefined, null, false, 0, -0, NaN, '', true, 1, -1, Infinity, 'x'];
  for (const value of values) {
    assert.ok(
      Object.is(
        execute('export function main(x) { return x || "fallback"; }', [value]),
        value || 'fallback',
      ),
    );
    assert.ok(
      Object.is(
        execute('export function main(x) { return x && "right"; }', [value]),
        value && 'right',
      ),
    );
    assert.equal(execute('export function main(x) { return x ? 7 : 9; }', [value]), value ? 7 : 9);
    assert.equal(execute('export function main(x) { return !x; }', [value]), !value);
  }
});

test('host calls reveal left-to-right evaluation and skipped branches', () => {
  const seen: Value[] = [];
  const mark: HostFunction = (value) => {
    seen.push(value);
    return value;
  };
  const source = `import { mark } from './host.mjs';
    function pair(a, b) { return a * 10 + b; }
    export function main() {
      let sum = pair(mark(1), mark(2));
      false && mark(3);
      true || mark(4);
      let chosen = mark(0) ? mark(5) : mark(6);
      return sum + chosen + (mark(7) + mark(8));
    }`;
  assert.equal(execute(source, [], [mark]), 33);
  assert.deepEqual(seen, [1, 2, 0, 6, 7, 8]);
});

test('local helpers, recursion, forward declarations and export aliases execute', () => {
  const source = `export { entry as main };
    function entry(n) { return factorial(n) + later(3); }
    function factorial(n) { if (n <= 1) return 1; return n * factorial(n - 1); }
    function later(n) { return n + 2; }`;
  assert.equal(execute(source, [5]), 125);
});

test('block scope, if/while/for and update expression values match JavaScript', () => {
  const source = `export function main(n) {
    let result = 1;
    { const result = 50; let inner = result + 1; if (inner !== 51) return -1; }
    for (let i = 0; i < n; i++) { let result = i * 2; if (result > 2) n -= 1; }
    let j = 0;
    while (j < 3) { result += j++; }
    result += ++j;
    result *= 2;
    result -= 1;
    result /= 3;
    result %= 4;
    result **= 2;
    result <<= 1;
    result >>= 1;
    result >>>= 0;
    result |= 8;
    result &= 15;
    result ^= 2;
    return result;
  }`;
  assert.equal(execute(source, [5]), 11);
  assert.equal(execute('export function main() { let n = 2; return n++ * 10 + --n; }'), 22);
  assert.equal(execute('export function main() { let n = 2; return n-- * 10 + ++n; }'), 22);
  assert.equal(execute('export function main() { let n; if (true) n = 9; return n; }'), 9);
});

test('built-in scalar identifiers respect lexical shadowing', () => {
  assert.equal(
    execute(
      'export function main(undefined, NaN, Infinity) { return undefined + NaN + Infinity; }',
      [1, 2, 3],
    ),
    6,
  );
  assert.equal(execute('export function main() { const NaN = 4; return NaN; }'), 4);
  assert.equal(execute('export function main() { return; }'), undefined);
  assert.equal(execute('export function main() {}'), undefined);
  assert.equal(
    execute(
      'import { mark as NaN } from "host"; export function main() { return NaN(4); }',
      [],
      [(value) => value],
    ),
    4,
  );
  for (const name of ['undefined', 'NaN', 'Infinity']) {
    rejectsSource(
      `import { mark as ${name} } from "host"; export function main() { return ${name}; }`,
    );
  }
});

test('invalid lexical writes and temporal-dead-zone references fail explicitly', () => {
  for (const source of [
    'export function main() { const x = 1; x = 2; return x; }',
    'export function main() { const x = 1; x++; return x; }',
    'export function main() { let x = 1; let x = 2; return x; }',
    'export function main(x) { let x = 2; return x; }',
    'export function main() { return x; let x = 1; }',
    'export function main() { let x = x; return x; }',
    'export function main() { let x = 1; { return x; let x = 2; } }',
    'export function main() { { let x = 1; } return x; }',
    'export function main() { for (let i = 0; i < 2; i++) {} return i; }',
    'import { x } from "host"; export function main() { x = 2; return x; }',
  ])
    rejectsSource(source);
});

test('unsupported JavaScript never passes through as native executable source', () => {
  for (const source of [
    'export async function main() { return 1; }',
    'export function* main() { yield 1; }',
    'export function main() { return import("x"); }',
    'export function main() { return new Date(); }',
    'export function main() { return eval("1"); }',
    'export function main() { return Function("return 1")(); }',
    'export function main() { return [1, 2]; }',
    'export function main() { return {x: 1}; }',
    'export function main(x) { return x.value; }',
    'export function main(x) { return x[0]; }',
    'export function main() { return () => 1; }',
    'export function main() { function nested() { return 1; } return nested(); }',
    'export function main() { return 1n; }',
    'export function main() { return /x/; }',
    'export function main(x) { return `value:${x}`; }',
    'export function main() { return this; }',
    'export function main(x) { return typeof x; }',
    'export function main(x) { return x == 1; }',
    'export function main(x) { return x ?? 1; }',
    'export function main() { while (true) { break; } }',
    'export function main() { for (;;) { continue; } }',
    'export function main() { try { return 1; } catch (e) { return 2; } }',
    'export function main() { throw 1; }',
    'export function main() { var x = 1; return x; }',
    'export function main(x = 1) { return x; }',
    'export function main(...args) { return 1; }',
    'export function main({x}) { return x; }',
    'import "host"; export function main() { return 1; }',
    'import * as host from "host"; export function main() { return 1; }',
    'export { main } from "host";',
    'export * from "host";',
    'const x = 1; export function main() { return x; }',
    'export const main = 1;',
    'export default 1;',
    'class Example {}',
    'export function main( {',
    'export function main() { return 1 +; }',
    'export function main() {} trailing garbage',
  ])
    rejectsSource(source);
});

test('strict ESM reserved bindings are rejected in every supported binding position', () => {
  for (const name of ['eval', 'arguments', 'await', 'yield', 'implements', 'let']) {
    for (const source of [
      `export function main(${name}) { return 1; }`,
      `export function main() { let ${name} = 1; return 1; }`,
      `export function main() { const ${name} = 1; return 1; }`,
      `function ${name}() { return 1; } export function main() { return 1; }`,
      `import { host as ${name} } from './host.mjs'; export function main() { return 1; }`,
      `import ${name} from './host.mjs'; export function main() { return 1; }`,
    ])
      rejectsSource(source);
  }
});

test('disposal declarations and empty side-effect imports receive explicit diagnostics', () => {
  for (const source of [
    'export function main() { using x = 1; return 1; }',
    'export function main() { await using x = null; return 1; }',
    'using x = 1; export function main() { return 1; }',
    'await using x = null; export function main() { return 1; }',
    "import {} from './host.mjs'; export function main() { return 1; }",
  ])
    rejectsSource(source);
});

test('lexical declarations used as single statement bodies fail with CompileError', () => {
  for (const source of [
    'export function main() { if (true) let x = 1; return 1; }',
    'export function main() { if (true) {} else const x = 1; return 1; }',
    'export function main() { while (false) let x = 1; return 1; }',
    'export function main() { for (; false;) const x = 1; return 1; }',
  ])
    rejectsSource(source);
});

test('ten-minute epochs are deterministic and enforce dialect and expiry boundaries', () => {
  const source = 'export function main(x) { return x + 1; }';
  const a = compileModule(source, { now: NOW, variant: 'a' });
  const same = compileModule(source, { now: NOW + 1, variant: 'a' });
  const variant = compileModule(source, { now: NOW, variant: 'b' });
  const next = compileModule(source, { now: (a.artifact.epoch + 1) * EPOCH_MS, variant: 'a' });
  assert.deepEqual(a, same);
  assert.equal(a.artifact.epoch, Math.floor(NOW / EPOCH_MS));
  assert.equal(a.artifact.notBefore, a.artifact.epoch * EPOCH_MS);
  assert.equal(a.artifact.expiresAt, (a.artifact.epoch + 1) * EPOCH_MS);
  assert.notDeepEqual(a.dialect, variant.dialect);
  assert.notDeepEqual(a.dialect, next.dialect);
  assert.throws(() => instantiate(a.artifact, variant.dialect, [], { now: () => NOW }));
  let clock = a.artifact.expiresAt - 1;
  const instance = instantiate(a.artifact, a.dialect, [], { now: () => clock });
  assert.equal(instance.invoke('main', [3]), 4);
  clock++;
  assert.throws(() => instance.invoke('main', [3]));
  assert.throws(() =>
    instantiate(a.artifact, a.dialect, [], { now: () => a.artifact.expiresAt }).invoke('main', [3]),
  );
  assert.throws(() => instantiate(a.artifact, a.dialect, [], { now: () => a.artifact.expiresAt }));
});
