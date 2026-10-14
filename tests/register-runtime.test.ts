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
} from '../src/register-contract.js';
import { instantiate } from '../src/register-runtime.js';

// Independent register bytecode fixtures: no source compiler or stack IR is involved.
function fixture() {
  const dialect: Dialect = {
    format: DIALECT_FORMAT,
    id: 'register-test',
    epoch: 12,
    opcodes: OPS.map((_, index) => 255 - index),
  };
  const i = (op: Op, dst = 0, a = 0, b = 0, c = 0): Instruction => [
    dialect.opcodes[OPS.indexOf(op)]!,
    dst,
    a,
    b,
    c,
  ];
  const artifact: Artifact = {
    format: FORMAT,
    dialect: dialect.id,
    epoch: dialect.epoch,
    notBefore: dialect.epoch * EPOCH_MS,
    expiresAt: (dialect.epoch + 1) * EPOCH_MS,
    constants: [42],
    imports: [],
    functions: [{ parameters: 0, registers: 1, code: [i('constant'), i('return')] }],
    exports: [{ name: 'main', function: 0 }],
  };
  return { artifact, dialect, i, now: () => artifact.notBefore };
}

const error =
  (code: string) =>
  (caught: unknown): boolean =>
    caught instanceof VaultError && caught.code === code && caught.message === code;

test('register runtime enforces the exact validity interval at instantiation and each invocation', () => {
  const { artifact, dialect } = fixture();
  for (const instant of [artifact.notBefore - 1, artifact.expiresAt]) {
    assert.throws(
      () => instantiate(artifact, dialect, [], { now: () => instant }),
      error(instant < artifact.notBefore ? 'NOT_YET_VALID' : 'EXPIRED'),
    );
  }
  let instant = artifact.notBefore;
  const instance = instantiate(artifact, dialect, [], { now: () => instant });
  assert.equal(instance.invoke('main', []), 42);
  assert.equal(instance.invoke('main', []), 42);
  instant = artifact.expiresAt - 1;
  assert.equal(instance.invoke('main', []), 42);
  instant++;
  assert.throws(() => instance.invoke('main', []), error('EXPIRED'));
  instant = artifact.notBefore - 1;
  assert.throws(() => instance.invoke('main', []), error('NOT_YET_VALID'));
});

test('clock failures and expiry between register instructions fail closed', () => {
  const { artifact, dialect } = fixture();
  for (const bad of [NaN, Infinity, -1, 'bad']) {
    assert.throws(
      () => instantiate(artifact, dialect, [], { now: (() => bad) as () => number }),
      error('INVALID_CLOCK'),
    );
  }
  assert.throws(
    () =>
      instantiate(artifact, dialect, [], {
        now: () => {
          throw new Error('secret');
        },
      }),
    error('INVALID_CLOCK'),
  );
  let checks = 0;
  const instance = instantiate(artifact, dialect, [], {
    now: () => (++checks < 4 ? artifact.notBefore : artifact.expiresAt),
  });
  assert.throws(() => instance.invoke('main', []), error('EXPIRED'));
  assert.equal(checks, 4);
});

test('register schema rejects malformed records, intervals, and oversized data', () => {
  const mutations: ((artifact: Artifact) => void)[] = [
    (a) => {
      Object.assign(a, { extra: true });
    },
    (a) => {
      a.format = 'JOVLT-0' as typeof FORMAT;
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
      a.functions[0]!.parameters = LIMITS.parameters + 1;
    },
    (a) => {
      a.functions[0]!.registers = LIMITS.registers + 1;
    },
    (a) => {
      a.functions[0]!.parameters = 2;
    },
    (a) => {
      Object.assign(a.functions[0]!, { locals: 0 });
    },
    (a) => {
      a.exports.push({ name: 'main', function: 0 });
    },
    (a) => {
      a.exports[0]!.function = 1;
    },
    (a) => {
      a.functions[0]!.code = new Array(LIMITS.instructions + 1).fill([0, 0, 0, 0, 0]);
    },
  ];
  for (const mutate of mutations) {
    const { artifact, dialect, now } = fixture();
    mutate(artifact);
    assert.throws(() => instantiate(artifact, dialect, [], { now }), error('INVALID_ARTIFACT'));
  }
});

test('register opcode profiles require exact unique byte permutations and matching identity', () => {
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

test('each register operand and unused field is validated before execution', () => {
  const { artifact, dialect, i, now } = fixture();
  const invalid: unknown[] = [
    [0, 0, 0, 0, 0],
    [dialect.opcodes[0], 0, 0],
    [dialect.opcodes[0], -1, 0, 0, 0],
    i('constant', 1),
    i('constant', 0, 1),
    i('constant', 0, 0, 1),
    i('undefined', 0, 1),
    i('nop', 1),
    i('nop', 0, 1),
    i('move', 1),
    i('move', 0, 1),
    i('move', 0, 0, 1),
    i('add', 1),
    i('add', 0, 1),
    i('add', 0, 0, 1),
    i('add', 0, 0, 0, 1),
    i('jump', 1),
    i('jump', 0, 2),
    i('jump', 0, 0, 1),
    i('jump_false', 0, 1),
    i('jump_true', 0, 0, 2),
    i('jump_true', 1),
    i('call', 1),
    i('call', 0, 1),
    i('call', 0, 0, 1, 1),
    i('call', 0, 0, 0, 65),
    i('host_call'),
    i('return', 1),
    i('return', 0, 1),
    i('return', 0, 0, 1),
  ];
  for (const bad of invalid) {
    artifact.functions[0]!.code = [bad as Instruction, i('return')];
    assert.throws(() => instantiate(artifact, dialect, [], { now }), error('INVALID_ARTIFACT'));
  }
});

test('schema validation rejects prototype tricks, getters, sparse arrays, symbols and hidden fields', () => {
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
});

test('register instances snapshot profile, artifact, options and explicit host bindings', () => {
  const { artifact, dialect, i, now } = fixture();
  artifact.imports = [{ source: 'capability', imported: 'mutate' }];
  artifact.functions[0]!.code = [i('host_call'), i('constant'), i('return')];
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
  hosts[0] = () => {
    throw new Error('replacement');
  };
  options.now = () => artifact.expiresAt;
  assert.equal(instance.invoke('main', []), 42);
  assert.equal(instance.invoke('main', []), 42);
  assert.equal(Object.isFrozen(instance), true);
});

test('register calls copy contiguous arguments into fresh frames and route explicit return destinations', () => {
  const { artifact, dialect, i, now } = fixture();
  artifact.constants = [10, 20];
  artifact.functions = [
    {
      parameters: 0,
      registers: 5,
      code: [
        i('constant', 2),
        i('constant', 3, 1),
        i('call', 4, 1, 2, 2),
        i('add', 4, 4, 2),
        i('return', 0, 4),
      ],
    },
    {
      parameters: 2,
      registers: 3,
      code: [i('subtract', 2, 0, 1), i('undefined', 0), i('return', 0, 2)],
    },
  ];
  assert.equal(instantiate(artifact, dialect, [], { now }).invoke('main', []), 0);
  artifact.functions[0]!.code = [i('call', 4, 1, 5, 0), i('return', 0, 4)];
  assert.equal(
    Number.isNaN(instantiate(artifact, dialect, [], { now }).invoke('main', []) as number),
    true,
  );
});

test('register host calls retain argument order, isolate errors, and reject invalid results', () => {
  const { artifact, dialect, i, now } = fixture();
  artifact.imports = [{ source: 'capability', imported: 'combine' }];
  artifact.functions[0] = {
    parameters: 2,
    registers: 3,
    code: [i('host_call', 2, 0, 0, 2), i('return', 0, 2)],
  };
  assert.throws(() => instantiate(artifact, dialect, [], { now }), error('INVALID_HOSTS'));
  assert.equal(
    instantiate(artifact, dialect, [(a, b) => String(a) + String(b)], { now }).invoke('main', [
      'a',
      2,
    ]),
    'a2',
  );
  assert.throws(
    () =>
      instantiate(
        artifact,
        dialect,
        [
          () => {
            throw new Error('secret');
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
  let instant = artifact.notBefore;
  const instance = instantiate(
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
  assert.throws(() => instance.invoke('main', []), error('EXPIRED'));
});

test('reentry cannot reset register invocation budgets and the active guard resets after failure', () => {
  const { artifact, dialect, i, now } = fixture();
  artifact.imports = [{ source: 'capability', imported: 'reenter' }];
  artifact.functions[0]!.code = [i('host_call'), i('return')];
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

test('register instruction budgets are fresh per invocation and shared across calls', () => {
  const { artifact, dialect, i, now } = fixture();
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
  artifact.functions[0]!.code = [i('jump')];
  assert.throws(
    () => instantiate(artifact, dialect, [], { now, maxSteps: 5 }).invoke('main', []),
    error('STEP_LIMIT'),
  );
  artifact.functions = [
    { parameters: 0, registers: 1, code: [i('call', 0, 1), i('return')] },
    { parameters: 0, registers: 1, code: [i('constant'), i('return')] },
  ];
  assert.throws(
    () => instantiate(artifact, dialect, [], { now, maxSteps: 3 }).invoke('main', []),
    error('STEP_LIMIT'),
  );
  assert.equal(instantiate(artifact, dialect, [], { now, maxSteps: 4 }).invoke('main', []), 42);
  artifact.functions[0]!.code = [i('call')];
  assert.throws(
    () => instantiate(artifact, dialect, [], { now }).invoke('main', []),
    error('CALL_DEPTH'),
  );
});

test('register arguments allow omitted and extra primitives but reject objects and oversized arrays', () => {
  const { artifact, dialect, i, now } = fixture();
  artifact.functions[0] = { parameters: 2, registers: 2, code: [i('return', 0, 1)] };
  const instance = instantiate(artifact, dialect, [], { now });
  assert.equal(instance.invoke('main', []), undefined);
  assert.equal(instance.invoke('main', [1, 'second', 3]), 'second');
  assert.throws(() => instance.invoke('missing', []), error('INVALID_EXPORT'));
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

test('move, undefined, nop, and branches operate on explicit registers without consuming conditions', () => {
  const { artifact, dialect, i, now } = fixture();
  for (const branch of ['jump_false', 'jump_true'] as const) {
    artifact.functions[0] = {
      parameters: 1,
      registers: 2,
      code: [i('move', 1, 0), i('nop'), i(branch, 0, 1, 4), i('undefined', 0), i('return', 0, 1)],
    };
    const instance = instantiate(artifact, dialect, [], { now });
    assert.equal(instance.invoke('main', [true]), true);
    assert.equal(instance.invoke('main', [false]), false);
  }
});

test('register binary and unary semantics preserve the supported JS primitive subset', () => {
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
    const { artifact, dialect, i, now } = fixture();
    artifact.functions[0] = {
      parameters: 2,
      registers: 3,
      code: [i(op, 2, 0, 1), i('return', 0, 2)],
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
  for (const [op, input, expected] of [
    ['negate', 0, -0],
    ['positive', undefined, NaN],
    ['not', '', true],
    ['bit_not', null, -1],
  ] as [Op, Value, Value][]) {
    const { artifact, dialect, i, now } = fixture();
    artifact.functions[0] = { parameters: 1, registers: 2, code: [i(op, 1, 0), i('return', 0, 1)] };
    assert.equal(
      Object.is(instantiate(artifact, dialect, [], { now }).invoke('main', [input]), expected),
      true,
      op,
    );
  }
});
