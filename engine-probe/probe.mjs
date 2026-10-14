// Private trusted-image experiment; this is not an untrusted checkpoint loader.
import assert from 'node:assert/strict';
import { createHash, randomFillSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const path = fileURLToPath(
  new URL(
    './target/wasm32-unknown-unknown/release/jovault_boa_snapshot_probe.wasm',
    import.meta.url,
  ),
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Conservative inspection for Rust's ordinary numeric global initializers.
// Reject unknown encodings instead of silently omitting hidden mutable globals.
function inspectGlobals(bytes) {
  let position = 8;
  const uleb = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[position++];
      value += (byte & 127) * 2 ** shift;
      shift += 7;
      assert.ok(shift <= 35);
    } while (byte & 128);
    return value;
  };
  const string = () => {
    const size = uleb();
    const value = new TextDecoder().decode(bytes.subarray(position, position + size));
    position += size;
    return value;
  };
  const globals = [];
  const exportedGlobals = new Map();
  while (position < bytes.length) {
    const section = bytes[position++];
    const length = uleb();
    const end = position + length;
    if (section === 6) {
      const count = uleb();
      for (let index = 0; index < count; index++) {
        const type = bytes[position++];
        const mutable = bytes[position++] === 1;
        const opcode = bytes[position++];
        if (opcode === 0x41 || opcode === 0x42) {
          while (bytes[position++] & 128) {
            /* Skip signed LEB constant. */
          }
        } else if (opcode === 0x43) position += 4;
        else if (opcode === 0x44) position += 8;
        else throw new Error(`Unreviewed global initializer opcode ${opcode}`);
        assert.equal(bytes[position++], 0x0b);
        globals.push({ index, type, mutable });
      }
    } else if (section === 7) {
      const count = uleb();
      for (let i = 0; i < count; i++) {
        const name = string();
        const kind = bytes[position++];
        const index = uleb();
        if (kind === 3) exportedGlobals.set(index, name);
      }
    }
    position = end;
  }
  for (const global of globals.filter((entry) => entry.mutable)) {
    assert.ok(exportedGlobals.has(global.index), `Hidden mutable global ${global.index}`);
    global.exportName = exportedGlobals.get(global.index);
  }
  return globals;
}
const fixtures = [
  { name: 'script-expression', mode: 0, expected: 42, source: 'globalThis.__executed = 1; 6 * 7;' },
  {
    name: 'script-closure-class',
    mode: 0,
    expected: 42,
    source:
      'globalThis.__executed = 1; class Box { #value; constructor(v) { this.#value = v; } get() { return this.#value; } } const offset = n => x => x + n; offset(2)(new Box(40).get());',
  },
  {
    name: 'module-closure-class',
    mode: 1,
    expected: 42,
    source:
      'globalThis.__executed = 1; class Counter { #n = 39; next() { return ++this.#n; } } const add = n => x => x + n; export function main() { const c = new Counter(); return add(2)(c.next()); }',
  },
  {
    name: 'module-async',
    mode: 1,
    expected: 42,
    source:
      'globalThis.__executed = 1; export async function main() { const x = await Promise.resolve(40); return x + 2; }',
  },
  {
    name: 'module-builtins',
    mode: 1,
    expected: 42,
    source:
      'globalThis.__executed = 1; export function main() { const m = new Map([["a", 39n]]); const r = /a+/u.test("aaa") ? 1 : 0; return Number(m.get("a")) + r + new Uint8Array([2])[0]; }',
  },
];

async function runFixture(fixture) {
  const bytes = await readFile(path);
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module);
  assert.deepEqual(imports, [{ module: 'probe', name: 'entropy', kind: 'function' }]);
  const globalInventory = inspectGlobals(bytes);
  function instantiate() {
    let instance;
    instance = new WebAssembly.Instance(module, {
      probe: {
        entropy(ptr, len) {
          assert.ok(Number.isInteger(ptr) && Number.isInteger(len) && ptr >= 0 && len >= 0);
          assert.ok(ptr + len <= instance.exports.memory.buffer.byteLength);
          randomFillSync(new Uint8Array(instance.exports.memory.buffer, ptr, len));
        },
      },
    });
    return instance.exports;
  }
  const first = instantiate();
  const sourceMarker = `JOVAULT_SOURCE_COMMENT_ONLY_${fixture.name}`;
  const source = `/* ${sourceMarker} */\n${fixture.source}`;
  const input = new TextEncoder().encode(source);
  const ptr = first.alloc_input(input.byteLength);
  new Uint8Array(first.memory.buffer, ptr, input.byteLength).set(input);
  const originalStack = first.__stack_pointer.value;
  const root = first.compile_source(ptr, input.byteLength, fixture.mode);
  const error = (e) =>
    new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.error_ptr(), e.error_len()));
  assert.ok(root !== 0, error(first));
  assert.equal(first.guest_marker(), 0, 'compile must not execute guest top level');
  assert.equal(first.compile_calls(), 1);
  assert.equal(first.execute_calls(), 0);
  assert.equal(first.__stack_pointer.value, originalStack, 'quiescent ABI boundary restores stack');
  new Uint8Array(first.memory.buffer, ptr, input.byteLength).fill(0);
  input.fill(0);
  const checkpoint = new Uint8Array(first.memory.buffer).slice();
  const image = Buffer.from(checkpoint);
  const sourceRetentionDisabled = first.source_retention_disabled() === 1;
  const retainedSourceMarker =
    image.includes(Buffer.from(sourceMarker, 'utf8')) ||
    image.includes(Buffer.from(sourceMarker, 'utf16le'));
  const retainedFullSource =
    image.includes(Buffer.from(source, 'utf8')) || image.includes(Buffer.from(source, 'utf16le'));
  if (sourceRetentionDisabled) {
    assert.equal(retainedSourceMarker, false, 'comment marker must not remain in checkpoint');
    assert.equal(retainedFullSource, false, 'full source must not remain in checkpoint');
  }
  const globals = Object.entries(first)
    .filter(([, value]) => value instanceof WebAssembly.Global)
    .map(([name, value]) => ({ name, value: value.value }));
  const tableLength = first.__indirect_function_table.length;
  const second = instantiate();
  assert.equal(second.compile_calls(), 0);
  assert.equal(second.root_pointer(), 0);
  assert.equal(second.__indirect_function_table.length, tableLength);
  const missingPages = (checkpoint.byteLength - second.memory.buffer.byteLength) / 65536;
  assert.ok(Number.isInteger(missingPages) && missingPages >= 0);
  second.memory.grow(missingPages);
  new Uint8Array(second.memory.buffer).set(checkpoint);
  for (const global of globals) {
    if (second[global.name].value !== global.value) second[global.name].value = global.value;
  }
  assert.equal(second.compile_calls(), 1);
  assert.equal(second.execute_calls(), 0);
  assert.equal(second.root_pointer(), root);
  assert.ok(new Uint8Array(second.memory.buffer, ptr, input.byteLength).every((x) => x === 0));
  const result = second.invoke_compiled(); // No source or AST passed to this instance.
  assert.equal(result, fixture.expected, error(second));
  assert.equal(second.compile_calls(), 1);
  assert.equal(second.execute_calls(), 1);
  assert.equal(second.guest_marker(), 1);
  return {
    name: fixture.name,
    result,
    wasmSha256: digest(bytes),
    checkpointSha256: digest(checkpoint),
    wasmBytes: bytes.byteLength,
    checkpointBytes: checkpoint.byteLength,
    root,
    globals,
    globalInventory,
    tableLength,
    compileCalls: second.compile_calls(),
    executeCalls: second.execute_calls(),
    inputZeroed: true,
    sourceRetentionDisabled,
    retainedSourceMarker,
    retainedFullSource,
    note: 'Whole linear-memory checkpoint includes compiled register code and heap, potentially retained SourceText; not portable bytecode.',
  };
}

if (!isMainThread) {
  try {
    parentPort.postMessage({ ok: true, result: await runFixture(workerData) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.stack });
  }
} else {
  const results = [];
  for (const fixture of fixtures) {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: fixture,
        resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 8 },
      });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`timeout: ${fixture.name}`));
      }, 15000);
      worker.once('message', (message) => {
        clearTimeout(timer);
        worker.terminate();
        message.ok ? resolve(message.result) : reject(new Error(message.error));
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    results.push(result);
    console.log(JSON.stringify(result));
  }
  await writeFile(
    new URL('./results.json', import.meta.url),
    JSON.stringify(results, null, 2) + '\n',
  );
}
