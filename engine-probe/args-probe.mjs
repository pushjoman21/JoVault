// Primitive-argument ABI research; guest source runs only in the restored Boa WASM VM.
import assert from 'node:assert/strict';
import { createHash, randomFillSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const wasmPath =
  process.env.JOVLT_PROBE_WASM ??
  fileURLToPath(
    new URL(
      './target/wasm32-unknown-unknown/release/jovault_boa_snapshot_probe.wasm',
      import.meta.url,
    ),
  );
function inspectGlobals(bytes) {
  let cursor = 8;
  const uleb = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[cursor++];
      assert.ok(byte !== undefined && shift <= 28, 'bounded global inspection');
      value += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  const text = () => {
    const size = uleb();
    const value = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(cursor, cursor + size),
    );
    cursor += size;
    return value;
  };
  const globals = [];
  const exported = new Map();
  while (cursor < bytes.length) {
    const section = bytes[cursor++];
    const size = uleb();
    const end = cursor + size;
    assert.ok(end <= bytes.length);
    if (section === 6) {
      const count = uleb();
      for (let index = 0; index < count; index++) {
        const type = bytes[cursor++];
        const mutable = bytes[cursor++] === 1;
        const opcode = bytes[cursor++];
        if (opcode === 0x41 || opcode === 0x42) {
          let skipped = 0;
          while (bytes[cursor++] & 128) assert.ok(++skipped < 10);
        } else if (opcode === 0x43) cursor += 4;
        else if (opcode === 0x44) cursor += 8;
        else throw new Error(`unreviewed global initializer ${opcode}`);
        assert.equal(bytes[cursor++], 0x0b);
        globals.push({ index, type, mutable });
      }
    } else if (section === 7) {
      const count = uleb();
      for (let index = 0; index < count; index++) {
        const name = text();
        const kind = bytes[cursor++];
        const globalIndex = uleb();
        if (kind === 3) exported.set(globalIndex, name);
      }
    }
    cursor = end;
  }
  for (const global of globals.filter((item) => item.mutable)) {
    assert.ok(exported.has(global.index), `hidden mutable global ${global.index}`);
    global.exportName = exported.get(global.index);
  }
  return globals;
}

function readText(exports, pointer, length) {
  assert.ok(Number.isInteger(pointer) && Number.isInteger(length) && pointer >= 0 && length >= 0);
  assert.ok(pointer + length <= exports.memory.buffer.byteLength);
  return new TextDecoder('utf-8', { fatal: true }).decode(
    new Uint8Array(exports.memory.buffer, pointer, length),
  );
}

function resultValue(result) {
  assert.ok(result && typeof result === 'object' && !Array.isArray(result));
  if (result.type === 'undefined' || result.type === 'null') {
    assert.deepEqual(Object.keys(result), ['type']);
    return result.type === 'undefined' ? undefined : null;
  }
  assert.deepEqual(Object.keys(result), ['type', 'value']);
  if (result.type === 'number') {
    if (typeof result.value === 'number') return result.value;
    if (result.value === '-0') return -0;
    if (result.value === 'NaN') return NaN;
    if (result.value === 'Infinity') return Infinity;
    if (result.value === '-Infinity') return -Infinity;
  }
  if (result.type === 'string' && typeof result.value === 'string') return result.value;
  if (result.type === 'boolean' && typeof result.value === 'boolean') return result.value;
  throw new Error('invalid primitive result encoding');
}

const demoSource = `export function main(value) {
  let mixed = value | 0;
  for (let i = 0; i < 8; i++) {
    mixed = ((mixed ^ (i + 17)) * 31) | 0;
  }
  return mixed >>> 0;
}
`;

function cases() {
  const identity = 'export function main(value) { globalThis.__executed = 1; return value; }';
  return [
    ...[
      [123, 1368905075],
      [0, 553424416],
      [-1, 1200324359],
      [null, 553424416],
      [true, 4252153105],
      ['123', 1368905075],
    ].map(([input, expected]) => ({
      name: `demo-main-${JSON.stringify(input)}`,
      source: demoSource,
      args: [input],
      expected,
    })),
    {
      name: 'all-argument-positions',
      source:
        'export function main(a,b,c) { return String(a) + ":" + String(b) + ":" + String(c); }',
      args: [null, true, 'last'],
      expected: 'null:true:last',
    },
    {
      name: 'argument-async-resumption',
      source: 'export async function main(value) { return await Promise.resolve(value + 2); }',
      args: [5],
      expected: 7,
    },
    {
      name: 'argument-closure-class',
      source:
        'class Box { #n; constructor(value) { this.#n = value; } value() { return this.#n; } } const add = n => value => n + value; export function main(value) { return add(2)(new Box(value).value()); }',
      args: [40],
      expected: 42,
    },
    { name: 'omitted-argument', source: identity, args: [], expected: undefined },
    {
      name: 'extra-argument-count',
      source: 'export function main(first) { return arguments.length; }',
      args: Array(64).fill(1),
      expected: 64,
    },
    { name: 'null-argument', source: identity, args: [null], expected: null },
    { name: 'boolean-argument', source: identity, args: [false], expected: false },
    { name: 'negative-zero', source: identity, rawArgs: '[-0]', expected: -0 },
    {
      name: 'unicode-bmp-astral-crlf',
      source: identity,
      args: ['雪😀\r\n"\\'],
      expected: '雪😀\r\n"\\',
    },
    {
      name: 'unpaired-surrogate-argument',
      source: identity,
      rawArgs: '["\\ud800"]',
      expected: '\ud800',
    },
    {
      name: 'max-string-units',
      source: 'export function main(value) { return value.length; }',
      args: ['😀'.repeat(4096)],
      expected: 8192,
    },
    {
      name: 'namespace-export-names-before-evaluation',
      source:
        'export const before = 1; export function main(value) { return value; } export { main as alias };',
      args: [5],
      expected: 5,
      exportNames: ['alias', 'before', 'main'],
    },
    {
      name: 'no-ambient-host-apis',
      source:
        'export function main(value) { return typeof process === "undefined" && typeof fetch === "undefined" && typeof require === "undefined" && typeof value === "number"; }',
      args: [2],
      expected: true,
    },
    ...[
      ['non-array', '{}', 'ARGUMENT_JSON'],
      ['nested-object', '[{}]', 'ARGUMENT_UNSUPPORTED'],
      ['nested-array', '[[]]', 'ARGUMENT_UNSUPPORTED'],
      ['nonfinite-number', '[1e400]', 'ARGUMENT_NUMBER'],
      ['invalid-number-token', '[NaN]', 'ARGUMENT_JSON'],
      ['trailing-content', '[] true', 'ARGUMENT_JSON'],
      ['too-many', JSON.stringify(Array(65).fill(0)), 'ARGUMENT_COUNT'],
      ['oversized-string', JSON.stringify(['x'.repeat(8193)]), 'ARGUMENT_STRING_SIZE'],
    ].map(([name, rawArgs, reject]) => ({
      name: `invalid-${name}`,
      source: identity,
      rawArgs,
      reject,
    })),
    { name: 'invalid-utf8', source: identity, argumentBytes: [0xff], reject: 'ARGUMENT_UTF8' },
    {
      name: 'argument-byte-cap',
      source: identity,
      oversizedBytes: 4 * 1024 * 1024 + 1,
      reject: 'ARGUMENT_BYTES',
    },
    {
      name: 'bounded-guest-error-text',
      source:
        'export function main() { globalThis.__executed = 1; throw new Error("x".repeat(9000)); }',
      args: [],
      reject: 'Error: x',
      guestEntered: true,
    },
    {
      name: 'finite-loop-fuel-exhaustion-is-uncatchable',
      source:
        'export function main() { globalThis.__executed = (globalThis.__executed || 0) + 1; try { let total = 0; for (let i = 0; i < 50000; i++) total += i; return total; } catch { globalThis.__executed = 2; return "caught"; } finally { globalThis.__executed = 3; } }',
      args: [],
      reject: 'NoInstructionsRemainError',
      guestEntered: true,
      fuelExhaustion: true,
    },
  ];
}

async function run(job) {
  const bytes = await readFile(wasmPath);
  const module = await WebAssembly.compile(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: 'probe', name: 'entropy', kind: 'function' },
  ]);
  const globalsInventory = inspectGlobals(bytes);
  function instantiate() {
    let instance;
    instance = new WebAssembly.Instance(module, {
      probe: {
        entropy(pointer, length) {
          assert.ok(
            Number.isInteger(pointer) &&
              Number.isInteger(length) &&
              pointer >= 0 &&
              length >= 0 &&
              pointer + length <= instance.exports.memory.buffer.byteLength,
          );
          randomFillSync(new Uint8Array(instance.exports.memory.buffer, pointer, length));
        },
      },
    });
    return instance.exports;
  }
  const error = (exports) => {
    assert.ok(exports.error_len() <= 8192, 'error response must be bounded');
    return readText(exports, exports.error_ptr(), exports.error_len());
  };
  const first = instantiate();
  const graph = new TextEncoder().encode(
    JSON.stringify({
      format: 'JOVLT-BOA-INPUT0',
      entry: '/main.mjs',
      modules: [{ id: '/main.mjs', source: job.source }],
    }),
  );
  const pointer = first.alloc_input(graph.length);
  assert.ok(pointer);
  new Uint8Array(first.memory.buffer, pointer, graph.length).set(graph);
  const originalStack = first.__stack_pointer.value;
  const root = first.compile_graph(pointer, graph.length);
  assert.ok(root, error(first));
  assert.equal(first.compile_calls(), 1);
  assert.equal(first.execute_calls(), 0);
  assert.equal(first.guest_marker(), 0);
  assert.equal(first.source_buffers_wiped(), 1);
  assert.equal(
    first.instruction_budget_enabled(),
    1,
    'dedicated instruction-budget feature is required',
  );
  const budgetBefore = first.remaining_instructions();
  assert.equal(
    budgetBefore,
    200000,
    'compile, load and link must preserve the exact finite budget',
  );
  if (job.exportNames) {
    assert.equal(first.export_names_json(), 1, error(first));
    assert.deepEqual(
      JSON.parse(readText(first, first.result_ptr(), first.result_len())),
      job.exportNames,
    );
    assert.equal(first.execute_calls(), 0, 'namespace inspection must not evaluate bindings');
    assert.equal(first.guest_marker(), 0);
    assert.equal(first.remaining_instructions(), 200000, 'export metadata must not consume fuel');
  }
  assert.equal(first.__stack_pointer.value, originalStack);
  new Uint8Array(first.memory.buffer, pointer, graph.length).fill(0);
  graph.fill(0);
  const checkpoint = new Uint8Array(first.memory.buffer).slice();
  const globals = Object.entries(first)
    .filter(([, value]) => value instanceof WebAssembly.Global)
    .map(([name, value]) => ({ name, value: value.value }));
  const second = instantiate();
  assert.equal(second.compile_calls(), 0);
  const pages = (checkpoint.byteLength - second.memory.buffer.byteLength) / 65536;
  assert.ok(Number.isInteger(pages) && pages >= 0);
  if (pages) second.memory.grow(pages);
  assert.equal(second.__indirect_function_table.length, first.__indirect_function_table.length);
  new Uint8Array(second.memory.buffer).set(checkpoint);
  for (const global of globals)
    if (second[global.name].value !== global.value) second[global.name].value = global.value;
  assert.equal(second.compile_calls(), 1);
  assert.equal(second.execute_calls(), 0);
  assert.equal(second.remaining_instructions(), 200000, 'restoration must preserve finite fuel');
  assert.equal(second.root_pointer(), root);
  const input = job.oversizedBytes
    ? new Uint8Array(job.oversizedBytes)
    : job.argumentBytes
      ? Uint8Array.from(job.argumentBytes)
      : new TextEncoder().encode(job.rawArgs ?? JSON.stringify(job.args));
  const argumentPointer = second.alloc_input(input.length);
  assert.ok(argumentPointer);
  new Uint8Array(second.memory.buffer, argumentPointer, input.length).set(input);
  const status = second.invoke_json_args(argumentPointer, input.length);
  new Uint8Array(second.memory.buffer, argumentPointer, input.length).fill(0);
  input.fill(0);
  assert.ok(
    new Uint8Array(second.memory.buffer, argumentPointer, input.length).every((byte) => byte === 0),
  );
  assert.equal(second.compile_calls(), 1, 'restored invocation must not call a compile ABI');
  assert.equal(second.execute_calls(), 1);
  assert.equal(second.__stack_pointer.value, originalStack);
  const budgetAfter = second.remaining_instructions();
  assert.ok(budgetAfter <= budgetBefore, 'argument invocation must never refill context fuel');
  if (job.reject) {
    assert.equal(status, 0);
    assert.match(error(second), new RegExp(job.reject));
    assert.equal(
      second.guest_marker(),
      job.guestEntered ? 1 : 0,
      'invalid arguments must not enter guest main',
    );
    assert.equal(second.result_len(), 0);
    if (!job.guestEntered)
      assert.equal(
        budgetAfter,
        budgetBefore,
        'invalid arguments must not consume VM instruction fuel',
      );
    if (job.fuelExhaustion) {
      const failure = () => {
        assert.ok(second.error_json_len() > 0 && second.error_json_len() <= 128);
        return JSON.parse(readText(second, second.error_json_ptr(), second.error_json_len()));
      };
      const expectedFailure = { ok: false, error: { code: 'instruction_budget_exhausted' } };
      assert.deepEqual(failure(), expectedFailure);
      assert.equal(budgetAfter, 0);
      assert.equal(
        second.invoke_json(),
        0,
        'an exhausted context must not receive a fresh invocation budget',
      );
      assert.match(error(second), /NoInstructionsRemainError/);
      assert.deepEqual(failure(), expectedFailure);
      assert.equal(second.result_len(), 0);
      assert.equal(second.guest_marker(), 1, 'catch, finally and a second main entry must not run');
      assert.equal(second.remaining_instructions(), 0);
      assert.equal(second.execute_calls(), 2);
      assert.equal(second.compile_calls(), 1);
    }
    return {
      name: job.name,
      status: 'PASS',
      rejection: error(second),
      inputZeroed: true,
      compileCalls: second.compile_calls(),
      executeCalls: second.execute_calls(),
      budgetBefore,
      budgetAfter: second.remaining_instructions(),
    };
  }
  assert.equal(status, 1, error(second));
  const result = JSON.parse(readText(second, second.result_ptr(), second.result_len()));
  assert.ok(
    Object.is(resultValue(result), job.expected),
    `unexpected result ${JSON.stringify(result)}`,
  );
  return {
    name: job.name,
    status: 'PASS',
    result,
    wasmSha256: sha256(bytes),
    checkpointSha256: sha256(checkpoint),
    compileCalls: second.compile_calls(),
    executeCalls: second.execute_calls(),
    budgetBefore,
    budgetAfter,
    inputZeroed: true,
    globalsInventory,
  };
}

if (!isMainThread) {
  try {
    parentPort.postMessage(await run(workerData));
  } catch (error) {
    parentPort.postMessage({
      name: workerData.name,
      status: 'FAIL',
      error: String(error.stack ?? error),
    });
  }
} else if (process.argv.includes('--check-cases')) {
  const inventory = {
    status: 'CASES_CHECKED_ONLY',
    cases: cases().map(({ name, reject, exportNames }) => ({ name, rejects: reject, exportNames })),
    wasmExecuted: false,
  };
  assert.equal(new Set(inventory.cases.map(({ name }) => name)).size, inventory.cases.length);
  await writeFile(
    new URL('./argument-inventory.json', import.meta.url),
    JSON.stringify(inventory, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      status: inventory.status,
      count: inventory.cases.length,
      wasmExecuted: false,
    }),
  );
} else {
  const results = [];
  for (const job of cases()) {
    const result = await new Promise((resolve) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: job,
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 8 },
      });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ name: job.name, status: 'FAIL', error: 'worker exceeded 15 seconds' }),
        15000,
      );
      worker.once('message', finish);
      worker.once('error', (error) =>
        finish({ name: job.name, status: 'FAIL', error: String(error) }),
      );
      worker.once('exit', (code) => {
        if (!settled)
          finish({ name: job.name, status: 'FAIL', error: `worker exit ${code} without result` });
      });
    });
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const report = {
    denominator: results.length,
    pass: results.filter(({ status }) => status === 'PASS').length,
    fail: results.filter(({ status }) => status !== 'PASS').length,
    results,
    limitations:
      'Trusted same-build checkpoint and primitive JSON bridge only; no untrusted image safety, broad host APIs or full ECMAScript conformance claim.',
  };
  await writeFile(
    new URL('./argument-results.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n',
  );
  if (report.fail) process.exitCode = 1;
}
