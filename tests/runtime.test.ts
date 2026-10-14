import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DIALECT_FORMAT,
  EPOCH_MS,
  FORMAT,
  LIMITS,
  OPS,
  VaultError,
  type Artifact,
  type Dialect,
  type HostFunction,
  type Instruction,
  type Op,
  type Value,
  type VaultInstance,
} from '../src/ir.js';
import { instantiate } from './reference-runtime.js';

function fixture() {
  const dialect: Dialect = {
    format: DIALECT_FORMAT,
    id: 'test-dialect',
    epoch: 12,
    opcodes: OPS.map((_, index) => 255 - index),
  };
  const instruction = (op: Op, operand = 0, count = 0): Instruction => [
    dialect.opcodes[OPS.indexOf(op)]!,
    operand,
    count,
  ];
  const artifact: Artifact = {
    format: FORMAT,
    dialect: dialect.id,
    epoch: dialect.epoch,
    notBefore: dialect.epoch * EPOCH_MS,
    expiresAt: (dialect.epoch + 1) * EPOCH_MS,
    constants: [42],
    imports: [],
    functions: [
      { parameters: 0, locals: 0, code: [instruction('constant'), instruction('return')] },
    ],
    exports: [{ name: 'main', function: 0 }],
  };
  const now = () => artifact.notBefore;
  return { artifact, dialect, instruction, now };
}

function error(code: string) {
  return (caught: unknown): boolean =>
    caught instanceof VaultError && caught.code === code && caught.message === code;
}

test('valid intervals include notBefore and exclude expiresAt, allowing repeat invocations', () => {
  const { artifact, dialect } = fixture();
  assert.throws(
    () => instantiate(artifact, dialect, [], { now: () => artifact.expiresAt }),
    error('EXPIRED'),
  );
  assert.throws(
    () => instantiate(artifact, dialect, [], { now: () => artifact.notBefore - 1 }),
    error('NOT_YET_VALID'),
  );
  let instant = artifact.notBefore;
  const instance = instantiate(artifact, dialect, [], { now: () => instant });
  assert.equal(instance.invoke('main', []), 42);
  assert.equal(instance.invoke('main', []), 42);
  instant = artifact.expiresAt - 1;
  assert.equal(instance.invoke('main', []), 42);
  instant = artifact.expiresAt;
  assert.throws(() => instance.invoke('main', []), error('EXPIRED'));
  instant = artifact.notBefore - 1;
  assert.throws(() => instance.invoke('main', []), error('NOT_YET_VALID'));
});

test('clock failure and expiry are checked on every instruction and after hosts', () => {
  const { artifact, dialect, instruction } = fixture();
  for (const bad of [NaN, Infinity, -1, 'bad']) {
    const now = (() => bad) as () => number;
    assert.throws(
      () => instantiate(artifact, dialect, [], { now }).invoke('main', []),
      error('INVALID_CLOCK'),
    );
  }
  assert.throws(
    () =>
      instantiate(artifact, dialect, [], {
        now: () => {
          throw new Error('secret');
        },
      }).invoke('main', []),
    error('INVALID_CLOCK'),
  );
  let count = 0;
  const now = () => (++count < 3 ? artifact.notBefore : artifact.expiresAt);
  assert.throws(
    () => instantiate(artifact, dialect, [], { now }).invoke('main', []),
    error('EXPIRED'),
  );
  artifact.imports = [{ source: 'capability', imported: 'read' }];
  artifact.functions[0]!.code = [instruction('host_call'), instruction('return')];
  let instant = artifact.notBefore;
  const hostInstance = instantiate(
    artifact,
    dialect,
    [
      () => {
        instant = artifact.expiresAt;
        return 1;
      },
    ],
    { now: () => instant },
  );
  assert.throws(() => hostInstance.invoke('main', []), error('EXPIRED'));
});

test('exact bounded schema rejects malformed artifacts before execution', () => {
  const mutations: ((artifact: Artifact) => void)[] = [
    (a) => {
      Object.assign(a, { surprise: 1 });
    },
    (a) => {
      a.format = 'other' as typeof FORMAT;
    },
    (a) => {
      a.notBefore++;
    },
    (a) => {
      a.expiresAt++;
    },
    (a) => {
      a.epoch = -1;
    },
    (a) => {
      a.constants = [Infinity];
    },
    (a) => {
      a.constants = ['x'.repeat(LIMITS.stringLength + 1)];
    },
    (a) => {
      a.constants = new Array(LIMITS.constants + 1).fill(0);
    },
    (a) => {
      a.functions = [];
    },
    (a) => {
      a.functions[0]!.code = [];
    },
    (a) => {
      a.functions[0]!.parameters = 65;
    },
    (a) => {
      a.functions[0]!.locals = 4097;
    },
    (a) => {
      a.functions[0]!.parameters = 1;
    },
    (a) => {
      a.exports.push({ name: 'main', function: 0 });
    },
    (a) => {
      a.exports[0]!.function = 1;
    },
    (a) => {
      a.imports = [{ source: '', imported: 'x' }];
    },
  ];
  for (const mutate of mutations) {
    const { artifact, dialect, now } = fixture();
    mutate(artifact);
    assert.throws(() => instantiate(artifact, dialect, [], { now }), error('INVALID_ARTIFACT'));
  }
});

test('dialect permutations and pairing must match exactly', () => {
  const { artifact, dialect, now } = fixture();
  for (const opcodes of [
    [],
    [...dialect.opcodes, 1],
    dialect.opcodes.map(() => 1),
    dialect.opcodes.map((x) => x + 256),
  ]) {
    assert.throws(
      () => instantiate(artifact, { ...dialect, opcodes }, [], { now }),
      error('INVALID_DIALECT'),
    );
  }
  assert.throws(
    () => instantiate(artifact, { ...dialect, id: 'other' }, [], { now }),
    error('DIALECT_MISMATCH'),
  );
  assert.throws(
    () => instantiate(artifact, { ...dialect, epoch: 13 }, [], { now }),
    error('DIALECT_MISMATCH'),
  );
});

test('operands, unused operands, jumps, calls, and tuple arity are validated', () => {
  const { artifact, dialect, instruction, now } = fixture();
  const invalid: unknown[] = [
    [0, 0, 0],
    instruction('constant', 1),
    instruction('load'),
    instruction('store'),
    instruction('jump', 2),
    instruction('jump_false', 2),
    instruction('jump_true', 2),
    instruction('call', 1),
    instruction('host_call'),
    instruction('call', 0, 65),
    instruction('return', 1),
    instruction('add', 0, 1),
    [dialect.opcodes[0], 0],
    [dialect.opcodes[0], -1, 0],
    [dialect.opcodes[0], 0.1, 0],
  ];
  for (const bad of invalid) {
    artifact.functions[0]!.code = [bad as Instruction, instruction('return')];
    assert.throws(() => instantiate(artifact, dialect, [], { now }), error('INVALID_ARTIFACT'));
  }
});

test('validation rejects prototypes, accessors, sparse arrays, symbols, and hidden fields', () => {
  const { artifact, dialect, now } = fixture();
  assert.throws(
    () =>
      instantiate(
        Object.assign(Object.create({ inherited: true }) as object, artifact),
        dialect,
        [],
        { now },
      ),
    error('INVALID_ARTIFACT'),
  );
  let accessed = false;
  const getter = { ...artifact };
  Object.defineProperty(getter, 'constants', {
    enumerable: true,
    get: () => {
      accessed = true;
      return [];
    },
  });
  assert.throws(() => instantiate(getter, dialect, [], { now }), error('INVALID_ARTIFACT'));
  assert.equal(accessed, false);
  for (const key of ['hidden', Symbol('extra')]) {
    const extra = { ...artifact };
    Object.defineProperty(extra, key, { value: 0 });
    assert.throws(() => instantiate(extra, dialect, [], { now }), error('INVALID_ARTIFACT'));
  }
  assert.throws(
    () => instantiate({ ...artifact, constants: new Array(1) }, dialect, [], { now }),
    error('INVALID_ARTIFACT'),
  );
  const polluted = [42];
  Object.setPrototypeOf(polluted, null);
  assert.throws(
    () => instantiate({ ...artifact, constants: polluted }, dialect, [], { now }),
    error('INVALID_ARTIFACT'),
  );
});

test('instances snapshot artifact, profile, hosts, options, and host mutations', () => {
  const { artifact, dialect, instruction, now } = fixture();
  artifact.imports.push({ source: 'capability', imported: 'mutate' });
  artifact.functions[0]!.code = [
    instruction('host_call'),
    instruction('pop'),
    instruction('constant'),
    instruction('return'),
  ];
  const hosts: HostFunction[] = [
    () => {
      artifact.constants[0] = 999;
      artifact.functions[0]!.code = [];
      dialect.opcodes.fill(0);
      return undefined;
    },
  ];
  const options = { now };
  const instance = instantiate(artifact, dialect, hosts, options);
  hosts[0] = () => 900;
  options.now = () => artifact.expiresAt;
  assert.equal(instance.invoke('main', []), 42);
  assert.equal(instance.invoke('main', []), 42);
  assert.equal(Object.isFrozen(instance), true);
});

test('hosts are explicit bounded primitive capabilities and failures hide messages', () => {
  const { artifact, dialect, instruction, now } = fixture();
  artifact.imports.push({ source: 'capability', imported: 'echo' });
  artifact.functions[0]!.code = [
    instruction('constant'),
    instruction('host_call', 0, 1),
    instruction('return'),
  ];
  assert.throws(() => instantiate(artifact, dialect, [], { now }), error('INVALID_HOSTS'));
  assert.throws(
    () => instantiate(artifact, dialect, [null as unknown as () => Value], { now }),
    error('INVALID_HOSTS'),
  );
  assert.equal(instantiate(artifact, dialect, [(input) => input], { now }).invoke('main', []), 42);
  assert.throws(
    () =>
      instantiate(
        artifact,
        dialect,
        [
          () => {
            throw new Error('secret content');
          },
        ],
        { now },
      ).invoke('main', []),
    error('HOST_FAILURE'),
  );
  for (const result of [
    {},
    Promise.resolve(1),
    BigInt(1),
    Symbol(),
    'x'.repeat(LIMITS.stringLength + 1),
  ]) {
    assert.throws(
      () =>
        instantiate(artifact, dialect, [(() => result) as () => Value], { now }).invoke('main', []),
      error('INVALID_VALUE'),
    );
  }
});

test('same-instance reentry is rejected and active guard resets after errors', () => {
  const { artifact, dialect, instruction, now } = fixture();
  artifact.imports.push({ source: 'capability', imported: 'reenter' });
  artifact.functions[0]!.code = [instruction('host_call'), instruction('return')];
  let instance: VaultInstance;
  let entered = false;
  instance = instantiate(
    artifact,
    dialect,
    [
      () => {
        assert.throws(() => instance.invoke('main', []), error('REENTRANCY'));
        if (!entered) {
          entered = true;
          throw new Error('first');
        }
        return 7;
      },
    ],
    { now },
  );
  assert.throws(() => instance.invoke('main', []), error('HOST_FAILURE'));
  assert.equal(instance.invoke('main', []), 7);
});

test('fresh budgets, recursion, stack bounds, and underflow fail deterministically', () => {
  const { artifact, dialect, instruction, now } = fixture();
  const instance = instantiate(artifact, dialect, [], { now, maxSteps: 2 });
  assert.equal(instance.invoke('main', []), 42);
  assert.equal(instance.invoke('main', []), 42);
  assert.throws(
    () => instantiate(artifact, dialect, [], { now, maxSteps: 1 }).invoke('main', []),
    error('STEP_LIMIT'),
  );
  for (const maxSteps of [0, -1, 1.1, LIMITS.steps + 1]) {
    assert.throws(
      () => instantiate(artifact, dialect, [], { now, maxSteps }),
      error('INVALID_OPTIONS'),
    );
  }
  assert.throws(
    () => instantiate(artifact, dialect, [], { now, extra: true } as object),
    error('INVALID_OPTIONS'),
  );
  artifact.functions[0]!.code = [instruction('jump')];
  assert.throws(
    () => instantiate(artifact, dialect, [], { now, maxSteps: 5 }).invoke('main', []),
    error('STEP_LIMIT'),
  );
  artifact.functions[0]!.code = [instruction('call')];
  assert.throws(
    () => instantiate(artifact, dialect, [], { now }).invoke('main', []),
    error('CALL_DEPTH'),
  );
  artifact.functions[0]!.code = [instruction('undefined'), instruction('jump')];
  assert.throws(
    () => instantiate(artifact, dialect, [], { now }).invoke('main', []),
    error('STACK_LIMIT'),
  );
  for (const op of ['return', 'pop', 'dup', 'add', 'store', 'jump_false', 'jump_true'] as const) {
    artifact.functions[0]!.locals = 1;
    artifact.functions[0]!.code = [instruction(op)];
    assert.throws(
      () => instantiate(artifact, dialect, [], { now }).invoke('main', []),
      error('STACK_UNDERFLOW'),
    );
  }
});

test('arguments are primitive snapshots with omitted slots and extra arguments', () => {
  const { artifact, dialect, instruction, now } = fixture();
  artifact.functions[0] = {
    parameters: 2,
    locals: 2,
    code: [instruction('load', 1), instruction('return')],
  };
  const instance = instantiate(artifact, dialect, [], { now });
  assert.equal(instance.invoke('main', []), undefined);
  assert.equal(instance.invoke('main', [1, 'second', 3]), 'second');
  assert.throws(() => instance.invoke('absent', []), error('INVALID_EXPORT'));
  for (const args of [
    [{}],
    [BigInt(1)],
    [Symbol()],
    new Array(65).fill(1),
    ['x'.repeat(LIMITS.stringLength + 1)],
  ]) {
    assert.throws(() => instance.invoke('main', args as Value[]), error('INVALID_VALUE'));
  }
});

test('calls use explicit counts, local store pops, and conditional branches pop', () => {
  const { artifact, dialect, instruction: i, now } = fixture();
  artifact.constants = [10, 20];
  artifact.functions = [
    {
      parameters: 0,
      locals: 1,
      code: [i('constant'), i('dup'), i('store'), i('constant', 1), i('call', 1, 2), i('return')],
    },
    { parameters: 2, locals: 2, code: [i('load'), i('load', 1), i('subtract'), i('return')] },
  ];
  assert.equal(instantiate(artifact, dialect, [], { now }).invoke('main', []), -10);
  for (const op of ['jump_false', 'jump_true'] as const) {
    artifact.functions[0]!.code = [i('undefined'), i(op, 2), i('return')];
    assert.throws(
      () => instantiate(artifact, dialect, [], { now }).invoke('main', []),
      error('STACK_UNDERFLOW'),
    );
  }
});

test('numeric, string, equality, comparison and bit semantics preserve JS primitives', () => {
  const cases: [Op, Value, Value, Value][] = [
    ['add', 'x', undefined, 'xundefined'],
    ['add', null, true, 1],
    ['add', -0, -0, -0],
    ['subtract', '2', true, 1],
    ['multiply', null, Infinity, NaN],
    ['divide', 1, 0, Infinity],
    ['divide', -0, 1, -0],
    ['remainder', -4, 2, -0],
    ['power', 2, 3, 8],
    ['equal', null, undefined, false],
    ['equal', '1', 1, false],
    ['not_equal', NaN, NaN, true],
    ['less', '20', '3', true],
    ['less', undefined, 1, false],
    ['less_equal', NaN, 1, false],
    ['greater', true, null, true],
    ['greater_equal', '3', 2, true],
    ['bit_and', '3', 1, 1],
    ['bit_or', undefined, 2, 2],
    ['bit_xor', 3, 1, 2],
    ['shift_left', 1, 33, 2],
    ['shift_right', -4, 1, -2],
    ['shift_unsigned', -1, 0, 4294967295],
  ];
  for (const [op, left, right, expected] of cases) {
    const { artifact, dialect, instruction: i, now } = fixture();
    artifact.functions[0] = {
      parameters: 2,
      locals: 2,
      code: [i('load'), i('load', 1), i(op), i('return')],
    };
    assert.equal(
      Object.is(
        instantiate(artifact, dialect, [], { now }).invoke('main', [left, right]),
        expected,
      ),
      true,
      op,
    );
  }
  const unary: [Op, Value, Value][] = [
    ['negate', 0, -0],
    ['positive', undefined, NaN],
    ['not', '', true],
    ['bit_not', null, -1],
  ];
  for (const [op, input, expected] of unary) {
    const { artifact, dialect, instruction: i, now } = fixture();
    artifact.functions[0] = { parameters: 1, locals: 1, code: [i('load'), i(op), i('return')] };
    assert.equal(
      Object.is(instantiate(artifact, dialect, [], { now }).invoke('main', [input]), expected),
      true,
      op,
    );
  }
});
