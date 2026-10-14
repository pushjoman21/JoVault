import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  BoaCheckpointError,
  captureBoaCheckpoint,
  copyTrustedBoaRuntime,
  createBoaInstance,
  decodeBoaCheckpoint,
  encodeBoaCheckpoint,
  instantiateBoaPackage,
  prepareBoaRuntime,
  type BoaArgument,
  type TrustedBoaRuntime,
} from '../src/boa-checkpoint.js';
import { NodePackageSigner } from '../src/package-signing.js';

const encoder = new TextEncoder();
const instant = 7_200_000;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (value: string) => [...encoder.encode(value)];
function unsigned(value: number): number[] {
  const result: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    result.push(byte | (value ? 128 : 0));
  } while (value);
  return result;
}
function constant(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value >>= 7;
    const more = value !== 0 || (byte & 64) !== 0;
    bytes.push(byte | (more ? 128 : 0));
    if (!more) break;
  } while (true);
  return [0x41, ...bytes];
}
const vector = (items: readonly number[][]) => [...unsigned(items.length), ...items.flat()];
const name = (value: string) => [...unsigned(text(value).length), ...text(value)];
const section = (id: number, content: number[]) => [id, ...unsigned(content.length), ...content];
const load = (offset: number) => [...constant(0), 0x28, 2, ...unsigned(offset)];
const store = (offset: number, value: number[]) => [
  ...constant(0),
  ...value,
  0x36,
  2,
  ...unsigned(offset),
];

// This tiny ABI test double exercises the adapter, not JavaScript engine conformance.
function fixture(
  options: { remaining?: number; status?: number; entropy?: boolean; result?: unknown } = {},
) {
  const result = encoder.encode(JSON.stringify(options.result ?? { type: 'number', value: 42 }));
  const names = encoder.encode('["main"]');
  const failure = encoder.encode('{"ok":false,"error":{"code":"instruction_budget_exhausted"}}');
  const select = (yes: number, no: number) => [
    ...load(16),
    0x04,
    0x7f,
    ...constant(yes),
    0x05,
    ...constant(no),
    0x0b,
  ];
  const functions: { name: string; type: number; code: number[] }[] = [];
  const add = (functionName: string, type: number, code: number[]) =>
    functions.push({ name: functionName, type, code });
  add('alloc_input', 2, constant(2048));
  add('compile_graph', 1, [
    ...store(0, constant(128)),
    ...store(4, [...load(4), ...constant(1), 0x6a]),
    ...store(12, constant(200_000)),
    ...constant(128),
  ]);
  for (const [functionName, offset] of [
    ['root_pointer', 0],
    ['compile_calls', 4],
    ['execute_calls', 8],
    ['remaining_instructions', 12],
  ] as const)
    add(functionName, 0, load(offset));
  for (const functionName of [
    'source_buffers_wiped',
    'source_bytes_wiped',
    'source_capacity_wiped',
    'source_retention_disabled',
    'linked_module_roots',
    'instruction_budget_enabled',
  ])
    add(functionName, 0, constant(1));
  add('export_names_json', 0, [...store(16, constant(1)), ...constant(1)]);
  add('invoke_json_args', 1, [
    ...store(16, constant(0)),
    ...store(8, constant(1)),
    ...store(12, constant(options.remaining ?? 199_999)),
    ...(options.entropy ? [...constant(60000), ...constant(1), 0x10, 0] : []),
    ...constant(options.status ?? 1),
  ]);
  add('result_ptr', 0, select(512, 256));
  add('result_len', 0, select(names.length, result.length));
  add('error_json_ptr', 0, constant(768));
  add('error_json_len', 0, constant(failure.length));
  add('error_ptr', 0, constant(0));
  add('error_len', 0, constant(0));
  const exports = [
    { name: 'memory', kind: 'Memory', index: 0, binaryKind: 2 },
    { name: '__indirect_function_table', kind: 'Table', index: 0, binaryKind: 1 },
    { name: '__stack_pointer', kind: 'Global', index: 0, binaryKind: 3 },
    ...functions.map((fn, index) => ({
      name: fn.name,
      kind: 'Func',
      index: index + 1,
      binaryKind: 0,
    })),
  ];
  const data = (offset: number, content: Uint8Array) => [
    0,
    ...constant(offset),
    0x0b,
    ...unsigned(content.length),
    ...content,
  ];
  const wasm = new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(
      1,
      vector([
        [0x60, 0, 1, 0x7f],
        [0x60, 2, 0x7f, 0x7f, 1, 0x7f],
        [0x60, 1, 0x7f, 1, 0x7f],
        [0x60, 2, 0x7f, 0x7f, 0],
      ]),
    ),
    ...section(2, vector([[...name('probe'), ...name('entropy'), 0, 3]])),
    ...section(3, vector(functions.map((fn) => unsigned(fn.type)))),
    ...section(4, vector([[0x70, 1, 1, 1]])),
    ...section(5, vector([[1, 1, 2]])),
    ...section(6, vector([[0x7f, 1, ...constant(1024), 0x0b]])),
    ...section(
      7,
      vector(
        exports.map((entry) => [...name(entry.name), entry.binaryKind, ...unsigned(entry.index)]),
      ),
    ),
    ...section(
      10,
      vector(
        functions.map((fn) => {
          const body = [0, ...fn.code, 0x0b];
          return [...unsigned(body.length), ...body];
        }),
      ),
    ),
    ...section(11, vector([data(256, result), data(512, names), data(768, failure)])),
  ]);
  const audit = {
    auditVersion: 1,
    binaryValidated: true,
    checkpointStateGatePassed: true,
    startFunction: null,
    wasmBytes: wasm.length,
    imports: [
      {
        kind: 'function',
        module: 'probe',
        name: 'entropy',
        type: { parameters: '[I32, I32]', results: '[]' },
      },
    ],
    memories: [
      {
        index: 0,
        initialPages: 1,
        maximumPages: 2,
        memory64: false,
        pageSizeLog2: null,
        shared: false,
      },
    ],
    tables: [
      {
        index: 0,
        elementType: 'funcref',
        initialElements: 1,
        maximumElements: 1,
        shared: false,
        table64: false,
        initializer: { mode: 'null' },
      },
    ],
    globals: [
      {
        index: 0,
        mutable: true,
        shared: false,
        valueType: 'I32',
        exportNames: ['__stack_pointer'],
      },
    ],
    exports: exports.map(({ name: exportName, kind, index }) => ({
      name: exportName,
      kind,
      index,
    })),
    rejectedOperatorCounts: {},
    rejectionReasons: [],
  };
  const auditBytes = encoder.encode(JSON.stringify(audit));
  return {
    wasm,
    audit,
    auditBytes,
    policy: { runtimeSha256: digest(wasm), auditSha256: digest(auditBytes) },
  };
}
async function prepared(options: Parameters<typeof fixture>[0] = {}) {
  const input = fixture(options);
  const runtime = await prepareBoaRuntime(input.wasm, input.auditBytes, input.policy);
  const abi = createBoaInstance(runtime);
  assert.equal(abi.compile_graph(0, 0), 128);
  const payload = encodeBoaCheckpoint(captureBoaCheckpoint(abi));
  const signer = new NodePackageSigner({ keyId: 'checkpoint-test' });
  const expected = {
    application: 'test-app',
    deployment: 'test-deployment',
    runtimeSha256: runtime.runtimeSha256,
  };
  const sign = (bytes: Uint8Array) =>
    signer.sign(bytes, { ...expected, kind: 'boa-checkpoint', abi: 1, now: instant });
  const trust = [signer.verificationKey({ notBefore: instant, expiresAt: instant + 600_000 })];
  return { input, runtime, abi, payload, expected, sign, trust, envelope: sign(payload) };
}
const hasCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof Error && 'code' in error);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  return true;
};

test('checkpoint header has a fixed independent layout and copied exact page image', () => {
  const memory = new Uint8Array(65536);
  memory[128] = 73;
  const encoded = encodeBoaCheckpoint({
    memory,
    tableLength: 1,
    rootPointer: 128,
    globals: [{ name: '__stack_pointer', value: 1024 }],
  });
  assert.deepEqual([...encoded.slice(0, 12)], [74, 79, 86, 76, 84, 66, 67, 49, 1, 0, 0, 0]);
  const header = new DataView(encoded.buffer);
  assert.equal(header.getUint32(12, true), 32 + header.getUint32(20, true));
  assert.equal(header.getUint32(16, true), 65536);
  assert.deepEqual([...encoded.slice(24, 32)], new Array(8).fill(0));
  memory[128] = 1;
  const decoded = decodeBoaCheckpoint(encoded);
  assert.equal(decoded.memory[128], 73);
  encoded.fill(0);
  assert.equal(decoded.memory[128], 73);
  assert.ok(Object.isFrozen(decoded.globals[0]));
});

test('checkpoint rejects bad versions, reserved fields, bounds, truncation and metadata', async () => {
  const { payload } = await prepared();
  for (const offset of [0, 8, 12, 16, 20, 24, 28]) {
    const changed = payload.slice();
    changed[offset] = changed[offset]! ^ 1;
    assert.throws(() => decodeBoaCheckpoint(changed), hasCode('CHECKPOINT_SCHEMA'));
  }
  assert.throws(() => decodeBoaCheckpoint(payload.slice(0, -1)), hasCode('CHECKPOINT_SCHEMA'));
  assert.throws(
    () => decodeBoaCheckpoint(new Uint8Array([...payload, 0])),
    hasCode('CHECKPOINT_SCHEMA'),
  );
  const malformed = payload.slice();
  malformed[32] = 255;
  assert.throws(() => decodeBoaCheckpoint(malformed), hasCode('CHECKPOINT_JSON'));
  assert.throws(
    () =>
      encodeBoaCheckpoint({
        ...decodeBoaCheckpoint(payload),
        globals: [{ name: '__stack_pointer', value: 1025 }],
      }),
    hasCode('CHECKPOINT_SCHEMA'),
  );
  assert.throws(
    () =>
      encodeBoaCheckpoint({
        ...decodeBoaCheckpoint(payload),
        memory: new Uint8Array(64 * 1024 * 1024),
      }),
    hasCode('CHECKPOINT_SIZE'),
  );
});

test('runtime requires both pinned digests and a matching successful audit', async () => {
  const input = fixture();
  await assert.rejects(
    prepareBoaRuntime(input.wasm, input.auditBytes, {
      ...input.policy,
      runtimeSha256: '0'.repeat(64),
    }),
    hasCode('RUNTIME_HASH'),
  );
  await assert.rejects(
    prepareBoaRuntime(input.wasm, input.auditBytes, {
      ...input.policy,
      auditSha256: '0'.repeat(64),
    }),
    hasCode('AUDIT_HASH'),
  );
  const failed = encoder.encode(
    JSON.stringify({ ...input.audit, checkpointStateGatePassed: false }),
  );
  await assert.rejects(
    prepareBoaRuntime(input.wasm, failed, { ...input.policy, auditSha256: digest(failed) }),
    hasCode('AUDIT_GATE'),
  );
  const mismatch = encoder.encode(
    JSON.stringify({
      ...input.audit,
      exports: input.audit.exports.filter((item) => item.name !== 'error_json_len'),
    }),
  );
  await assert.rejects(
    prepareBoaRuntime(input.wasm, mismatch, { ...input.policy, auditSha256: digest(mismatch) }),
    hasCode('AUDIT_GATE'),
  );
  assert.throws(() => copyTrustedBoaRuntime({} as TrustedBoaRuntime), hasCode('RUNTIME_UNTRUSTED'));
});

test('trusted runtime snapshots all caller bytes before its first await', async () => {
  const input = fixture();
  const pending = prepareBoaRuntime(input.wasm, input.auditBytes, input.policy);
  input.wasm.fill(0);
  input.auditBytes.fill(0);
  const runtime = await pending;
  const transfer = copyTrustedBoaRuntime(runtime);
  assert.equal(digest(transfer.wasmBytes), runtime.runtimeSha256);
  transfer.wasmBytes.fill(0);
  assert.notEqual(copyTrustedBoaRuntime(runtime).wasmBytes[1], 0);
});

test('authentication, context and malformed checkpoint failures precede instantiation', async () => {
  const setup = await prepared();
  const original = WebAssembly.Instance;
  let instantiations = 0;
  class CountedInstance extends original {
    constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
      instantiations++;
      super(module, imports);
    }
  }
  Object.defineProperty(WebAssembly, 'Instance', {
    value: CountedInstance,
    configurable: true,
    writable: true,
  });
  try {
    const tampered = setup.payload.slice();
    tampered[tampered.length - 1] = 1;
    const load = (envelope: unknown, payload = setup.payload, expected = setup.expected) =>
      instantiateBoaPackage(envelope, payload, setup.trust, expected, setup.runtime, {
        now: () => instant,
      });
    await assert.rejects(load(setup.envelope, tampered), hasCode('PACKAGE_DIGEST'));
    await assert.rejects(
      load({ ...setup.envelope, signature: 'A'.repeat(86) }),
      hasCode('PACKAGE_SIGNATURE'),
    );
    await assert.rejects(
      load(setup.envelope, setup.payload, { ...setup.expected, deployment: 'other' }),
      hasCode('PACKAGE_CONTEXT'),
    );
    const malformed = setup.payload.slice();
    malformed[24] = 1;
    await assert.rejects(load(setup.sign(malformed), malformed), hasCode('CHECKPOINT_SCHEMA'));
    let clockReads = 0;
    await assert.rejects(
      instantiateBoaPackage(
        setup.envelope,
        setup.payload,
        setup.trust,
        setup.expected,
        setup.runtime,
        {
          now: () => instant + (clockReads++ ? 600_000 : 0),
        },
      ),
      hasCode('PACKAGE_EXPIRED'),
    );
    assert.equal(instantiations, 0);
  } finally {
    Object.defineProperty(WebAssembly, 'Instance', {
      value: original,
      configurable: true,
      writable: true,
    });
  }
});

test('restored packages expose names, invoke once and never compile again', async () => {
  const setup = await prepared();
  const pending = instantiateBoaPackage(
    setup.envelope,
    setup.payload,
    setup.trust,
    setup.expected,
    setup.runtime,
    { now: () => instant },
  );
  setup.payload.fill(0);
  const instance = await pending;
  assert.deepEqual(instance.exportNames, ['main']);
  assert.ok(Object.isFrozen(instance.exportNames));
  assert.equal(instance.remainingInstructions, 200_000);
  assert.equal(instance.invoke([null, true, -0, '\ud800']), 42);
  assert.equal(instance.remainingInstructions, 199_999);
  assert.throws(() => instance.invoke(), hasCode('ALREADY_INVOKED'));
});

test('typed budget failure is separate from a successful return using the last fuel unit', async () => {
  for (const status of [0, 1]) {
    const setup = await prepared({ status, remaining: 0 });
    const instance = await instantiateBoaPackage(
      setup.envelope,
      setup.payload,
      setup.trust,
      setup.expected,
      setup.runtime,
      { now: () => instant },
    );
    if (status) assert.equal(instance.invoke(), 42);
    else assert.throws(() => instance.invoke(), hasCode('INSTRUCTION_BUDGET_EXHAUSTED'));
    assert.equal(instance.remainingInstructions, 0);
  }
});

test('primitive descriptors preserve numeric edge values and reject malformed results', async () => {
  for (const [value, expected] of [
    ['-0', -0],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ] as const) {
    const setup = await prepared({ result: { type: 'number', value } });
    const instance = await instantiateBoaPackage(
      setup.envelope,
      setup.payload,
      setup.trust,
      setup.expected,
      setup.runtime,
      { now: () => instant },
    );
    assert.ok(Object.is(instance.invoke(), expected));
  }
  const setup = await prepared({ result: { type: 'object', value: {} } });
  const instance = await instantiateBoaPackage(
    setup.envelope,
    setup.payload,
    setup.trust,
    setup.expected,
    setup.runtime,
    { now: () => instant },
  );
  assert.throws(() => instance.invoke(), hasCode('RUNTIME_ABI'));
});

test('argument boundary rejects objects, holes, accessors, nonfinite and oversized values', async () => {
  let reads = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  for (const args of [
    [{}],
    [undefined],
    [NaN],
    [Infinity],
    ['x'.repeat(8193)],
    new Array(1),
    accessor,
    new Array(65).fill(0),
  ]) {
    const setup = await prepared();
    const instance = await instantiateBoaPackage(
      setup.envelope,
      setup.payload,
      setup.trust,
      setup.expected,
      setup.runtime,
      { now: () => instant },
    );
    assert.throws(() => instance.invoke(args as readonly BoaArgument[]), BoaCheckpointError);
  }
  assert.equal(reads, 0);
});

test('expiry rejects stale entry and withholds a result when time advances during the call', async () => {
  const setup = await prepared({ entropy: true });
  let now = instant;
  const load = () =>
    instantiateBoaPackage(
      setup.envelope,
      setup.payload,
      setup.trust,
      setup.expected,
      setup.runtime,
      { now: () => now },
    );
  const stale = await load();
  now += 600_000;
  assert.throws(() => stale.invoke(), hasCode('EXPIRED'));
  await assert.rejects(load(), hasCode('PACKAGE_EXPIRED'));
  now = instant;
  const instance = await load();
  const random = crypto.getRandomValues;
  Object.defineProperty(crypto, 'getRandomValues', {
    configurable: true,
    value<T extends ArrayBufferView | null>(array: T): T {
      now += 600_000;
      return array;
    },
  });
  try {
    assert.throws(() => instance.invoke(), hasCode('EXPIRED'));
  } finally {
    Object.defineProperty(crypto, 'getRandomValues', { configurable: true, value: random });
  }
});
