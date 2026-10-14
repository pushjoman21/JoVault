// Trusted, same-build WASM checkpoint experiment. Guest JavaScript never runs in Node.
import assert from 'node:assert/strict';
import { createHash, randomFillSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function inspectGlobals(bytes) {
  let cursor = 8;
  const uleb = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[cursor++];
      assert.ok(byte !== undefined && shift <= 28);
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
  for (const global of globals.filter((entry) => entry.mutable)) {
    assert.ok(exported.has(global.index), 'hidden mutable global');
    global.exportName = exported.get(global.index);
  }
  return globals;
}

function readText(exports, pointer, length) {
  assert.ok(
    Number.isInteger(pointer) &&
      Number.isInteger(length) &&
      pointer >= 0 &&
      length >= 0 &&
      length <= 262144,
  );
  assert.ok(pointer + length <= exports.memory.buffer.byteLength);
  return new TextDecoder('utf-8', { fatal: true }).decode(
    new Uint8Array(exports.memory.buffer, pointer, length),
  );
}

export async function executeCheckpoint(job) {
  const bytes = await readFile(job.wasm);
  const module = await WebAssembly.compile(bytes);
  const wasmSha256 = sha256(bytes);
  const exportNames = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
  const required = [
    'compile_graph',
    'compiled_global_scripts',
    'global_script_evaluations',
    'global_scripts_initialized',
  ];
  const absent = required.filter((name) => !exportNames.has(name));
  if (absent.length)
    return { status: 'BLOCKED_ABI', phase: 'abi', wasmSha256, missingExports: absent };
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: 'probe', name: 'entropy', kind: 'function' },
  ]);
  const globalInventory = inspectGlobals(bytes);
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
  const first = instantiate();
  const input = new TextEncoder().encode(job.rawInput ?? JSON.stringify(job.graph));
  const pointer = first.alloc_input(input.length);
  assert.ok(pointer);
  new Uint8Array(first.memory.buffer, pointer, input.length).set(input);
  const root = first.compile_graph(pointer, input.length);
  const error = (exports) => readText(exports, exports.error_ptr(), exports.error_len());
  const failure = (exports) =>
    exports.error_json_len()
      ? JSON.parse(readText(exports, exports.error_json_ptr(), exports.error_json_len()))
      : null;
  assert.equal(first.compile_calls(), 1);
  assert.equal(first.execute_calls(), 0);
  assert.equal(first.guest_marker(), 0);
  assert.equal(first.global_script_evaluations(), 0);
  if (job.compileReject) {
    assert.equal(root, 0, 'expected compile rejection');
    assert.match(error(first), new RegExp(job.compileReject));
    return { status: 'PASS', phase: 'control-compile-rejection', wasmSha256, error: error(first) };
  }
  if (!root)
    return {
      status: 'FAIL',
      phase: 'compile-or-link',
      wasmSha256,
      error: error(first),
      failure: failure(first),
    };
  const globalCount = job.graph.globalScripts.length;
  assert.equal(first.compiled_global_scripts(), globalCount);
  assert.equal(first.global_scripts_initialized(), globalCount ? 0 : 1);
  assert.equal(first.source_buffers_wiped(), job.graph.modules.length + globalCount);
  assert.equal(
    first.source_bytes_wiped(),
    [...job.graph.globalScripts, ...job.graph.modules].reduce(
      (sum, entry) => sum + Buffer.byteLength(entry.source),
      0,
    ),
  );
  new Uint8Array(first.memory.buffer, pointer, input.length).fill(0);
  input.fill(0);
  const checkpoint = new Uint8Array(first.memory.buffer).slice();
  const globals = Object.entries(first)
    .filter(([, value]) => value instanceof WebAssembly.Global)
    .map(([name, value]) => ({ name, value: value.value }));
  const tableLength = first.__indirect_function_table.length;
  const second = instantiate();
  assert.equal(second.compile_calls(), 0);
  assert.equal(second.root_pointer(), 0);
  assert.equal(second.__indirect_function_table.length, tableLength);
  const pages = (checkpoint.length - second.memory.buffer.byteLength) / 65536;
  assert.ok(Number.isInteger(pages) && pages >= 0);
  if (pages) second.memory.grow(pages);
  new Uint8Array(second.memory.buffer).set(checkpoint);
  for (const global of globals)
    if (second[global.name].value !== global.value) second[global.name].value = global.value;
  assert.equal(second.root_pointer(), root);
  assert.equal(second.execute_calls(), 0);
  assert.equal(second.global_script_evaluations(), 0);
  assert.ok(
    new Uint8Array(second.memory.buffer, pointer, input.length).every((byte) => byte === 0),
  );
  const status = second.invoke_json();
  assert.equal(second.compile_calls(), 1);
  assert.equal(second.execute_calls(), 1);
  const evidence = {
    wasmSha256,
    checkpointSha256: sha256(checkpoint),
    checkpointBytes: checkpoint.length,
    compileCalls: second.compile_calls(),
    executeCalls: second.execute_calls(),
    compiledGlobalScripts: globalCount,
    globalScriptEvaluations: second.global_script_evaluations(),
    globalScriptsInitialized: second.global_scripts_initialized(),
    modules: job.graph.modules.length,
    inputZeroed: true,
    globalInventory,
    note: 'Trusted same-build image. No source passed to restored instance. ABI compile counter does not instrument internal lazy compilation.',
  };
  if (job.invokeReject) {
    assert.equal(status, 0);
    assert.match(error(second), new RegExp(job.invokeReject));
    const message = error(second);
    if (job.globalFailureLatch) {
      assert.equal(second.global_scripts_initialized(), 0);
      assert.equal(second.global_script_evaluations(), job.expectedEvaluations);
      assert.equal(second.invoke_json(), 0);
      assert.match(error(second), /GLOBAL_SCRIPT_INITIALIZATION_FAILED/u);
      assert.equal(second.global_script_evaluations(), job.expectedEvaluations);
    }
    return { status: 'PASS', phase: 'control-invoke-rejection', ...evidence, error: message };
  }
  if (!status)
    return {
      status: 'FAIL',
      phase: second.global_scripts_initialized()
        ? 'test-module-evaluation'
        : 'harness-initialization',
      ...evidence,
      error: error(second),
      failure: failure(second),
    };
  const result = JSON.parse(readText(second, second.result_ptr(), second.result_len()));
  assert.deepEqual(result, { type: 'number', value: job.expected });
  assert.equal(second.global_scripts_initialized(), 1);
  assert.equal(second.global_script_evaluations(), globalCount);
  if (job.invokeTwice) {
    assert.equal(second.invoke_json(), 1);
    assert.equal(second.global_script_evaluations(), globalCount);
    assert.equal(second.compile_calls(), 1);
    assert.deepEqual(
      JSON.parse(readText(second, second.result_ptr(), second.result_len())),
      result,
    );
  }
  return { status: 'PASS', phase: 'restored-module-completion', ...evidence, result };
}
