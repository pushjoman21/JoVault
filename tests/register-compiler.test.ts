import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModule as compileReference } from '../src/frontend.js';
import { compileModule } from '../src/register-compiler.js';
import {
  DIALECT_FORMAT,
  EPOCH_MS,
  FORMAT,
  LIMITS,
  OPS,
  type HostFunction,
  type Value,
} from '../src/register-contract.js';
import { instantiate } from '../src/register-runtime.js';

const NOW = 1_800_123;

function execute(source: string, args: Value[] = [], hosts: HostFunction[] = []): Value {
  const { artifact, dialect } = compileModule(source, { now: NOW, variant: 'register-acceptance' });
  return instantiate(artifact, dialect, hosts, { now: () => NOW }).invoke('main', args);
}

test('compiler emits only the explicit register wire format and instruction set', () => {
  const { artifact, dialect } = compileModule(
    `function add(a,b) { return a+b; }
    export function main(n) { let sum=0; for(let i=0;i<n;i++) sum=add(sum,i); return sum; }`,
    { now: NOW },
  );
  assert.equal(artifact.format, FORMAT);
  assert.equal(artifact.format, 'JOVLT-R0');
  assert.equal(dialect.format, DIALECT_FORMAT);
  assert.equal(dialect.format, 'JOVLT-RD0');
  assert.equal(dialect.opcodes.length, OPS.length);
  for (const forbidden of ['load', 'store', 'push', 'pop', 'dup'])
    assert.ok(!OPS.includes(forbidden as never));
  for (const fn of artifact.functions) {
    assert.deepEqual(Object.keys(fn).sort(), ['code', 'parameters', 'registers']);
    assert.ok(fn.registers >= Math.max(1, fn.parameters));
    assert.ok(fn.registers <= LIMITS.registers);
    for (const instruction of fn.code) {
      assert.equal(instruction.length, 5);
      assert.ok(instruction.every((operand) => Number.isSafeInteger(operand) && operand >= 0));
      assert.ok(dialect.opcodes.includes(instruction[0]));
    }
  }
  assert.equal(instantiate(artifact, dialect, [], { now: () => NOW }).invoke('main', [6]), 15);
});

test('branch joins and nested short-circuit expressions leave deterministic register values', () => {
  const source = `export function main(flag, n) {
    let total = flag ? 10 : 20;
    let selected = (flag && n) || (n ? n + 1 : 3);
    let i = 0;
    while (i < 4) { total += (i % 2 === 0 ? selected : -selected); i++; }
    if (flag) { let total = 100; selected += total; } else { selected -= 2; }
    return total * 1000 + selected;
  }`;
  for (const [flag, n, expected] of [
    [true, 4, 10104],
    [true, 0, 10103],
    [false, 4, 20003],
    [false, 0, 20001],
  ] as const)
    assert.equal(execute(source, [flag, n]), expected);
  assert.equal(execute('export function main() { let n=2; n += (n=5); return n; }'), 7);
  assert.equal(execute('export function main() { let n="2"; return n++ * 10 + --n; }'), 22);
});

test('register argument windows preserve prior arguments through nested and recursive calls', () => {
  const seen: Value[] = [];
  const host: HostFunction = (value) => {
    seen.push(value);
    return value;
  };
  const source = `import { mark } from './host.mjs';
    function pair(a,b) { return a*10+b; }
    function factorial(n) { if(n<=1) return 1; return n*factorial(n-1); }
    export function main() {
      let n=1;
      let first=pair(n++, pair(n++, n++));
      let second=pair(mark(4), pair(mark(5),mark(6)));
      return first + second + factorial(5);
    }`;
  assert.equal(execute(source, [], [host]), 249);
  assert.deepEqual(seen, [4, 5, 6]);
});

test('zero-argument calls and binary expressions cannot overlap pending call registers', () => {
  const seen: number[] = [];
  const hosts: HostFunction[] = [1, 2, 3].map((value) => () => {
    seen.push(value);
    return value;
  });
  const source = `import { a, b, c } from './host.mjs';
    function f(left,right) { return left*10+right; }
    function leaf() { return 9; }
    export function main() { return f(a()+b(),c())+leaf(); }`;
  assert.equal(execute(source, [], hosts), 42);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('register bounds and old stack artifacts have no fallback execution path', () => {
  const source = 'export function main(x) { return x+1; }';
  const compiled = compileModule(source, { now: NOW });
  for (const registers of [0, LIMITS.registers + 1]) {
    const artifact = structuredClone(compiled.artifact);
    artifact.functions[0]!.registers = registers;
    assert.throws(() => instantiate(artifact, compiled.dialect, [], { now: () => NOW }), {
      code: 'INVALID_ARTIFACT',
    });
  }
  const reference = compileReference(source, { now: NOW });
  assert.throws(() => instantiate(reference.artifact, reference.dialect, [], { now: () => NOW }), {
    code: 'INVALID_DIALECT',
  });
  assert.throws(() => instantiate(reference.artifact, compiled.dialect, [], { now: () => NOW }), {
    code: 'INVALID_ARTIFACT',
  });
  const artifact = structuredClone(compiled.artifact);
  artifact.format = reference.artifact.format as typeof artifact.format;
  assert.throws(() => instantiate(artifact, compiled.dialect, [], { now: () => NOW }), {
    code: 'INVALID_ARTIFACT',
  });
});

test('register dialects vary by ten-minute epoch and expire without negotiation', () => {
  const source = 'export function main(x) { return x+1; }';
  const first = compileModule(source, { now: NOW, variant: 'a' });
  const same = compileModule(source, { now: NOW + 1, variant: 'a' });
  const other = compileModule(source, { now: NOW, variant: 'b' });
  const next = compileModule(source, { now: first.artifact.expiresAt, variant: 'a' });
  assert.deepEqual(first, same);
  assert.equal(first.artifact.epoch, Math.floor(NOW / EPOCH_MS));
  assert.equal(first.artifact.notBefore, first.artifact.epoch * EPOCH_MS);
  assert.equal(first.artifact.expiresAt, first.artifact.notBefore + EPOCH_MS);
  assert.notDeepEqual(first.dialect, other.dialect);
  assert.notDeepEqual(first.dialect, next.dialect);
  assert.throws(() => instantiate(first.artifact, other.dialect, [], { now: () => NOW }));
  assert.throws(() => instantiate(first.artifact, next.dialect, [], { now: () => NOW }));
  assert.throws(() =>
    instantiate(first.artifact, first.dialect, [], { now: () => first.artifact.notBefore - 1 }),
  );
  let clock = first.artifact.expiresAt - 1;
  const live = instantiate(first.artifact, first.dialect, [], { now: () => clock });
  assert.equal(live.invoke('main', [3]), 4);
  clock++;
  assert.throws(() => live.invoke('main', [3]), { code: 'EXPIRED' });
  assert.throws(() => instantiate(first.artifact, first.dialect, [], { now: () => clock }), {
    code: 'EXPIRED',
  });
});
