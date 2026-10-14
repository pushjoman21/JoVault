// Trusted same-build checkpoint research. No guest module is imported by Node.
import assert from 'node:assert/strict';
import { createHash, randomFillSync } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const defaultWasm = fileURLToPath(
  new URL(
    './target/wasm32-unknown-unknown/release/jovault_boa_snapshot_probe.wasm',
    import.meta.url,
  ),
);
const defaultFixtures = fileURLToPath(new URL('../tests/conformance-fixtures/', import.meta.url));

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

async function runFixture(job) {
  const bytes = await readFile(job.wasm);
  const module = await WebAssembly.compile(bytes);
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
            Number.isInteger(pointer) && Number.isInteger(length) && pointer >= 0 && length >= 0,
          );
          assert.ok(pointer + length <= instance.exports.memory.buffer.byteLength);
          randomFillSync(new Uint8Array(instance.exports.memory.buffer, pointer, length));
        },
      },
    });
    return instance.exports;
  }
  const first = instantiate();
  const input = new TextEncoder().encode(job.rawInput ?? JSON.stringify(job.graph));
  const pointer = first.alloc_input(input.byteLength);
  assert.ok(pointer !== 0, 'input allocation was denied');
  new Uint8Array(first.memory.buffer, pointer, input.byteLength).set(input);
  const stack = first.__stack_pointer.value;
  const root = first.compile_graph(pointer, input.byteLength);
  const error = (exports) => readText(exports, exports.error_ptr(), exports.error_len());
  assert.equal(first.compile_calls(), 1);
  assert.equal(first.execute_calls(), 0);
  assert.equal(first.guest_marker(), 0, 'load/link must not evaluate guest code');
  assert.equal(first.__stack_pointer.value, stack);
  if (job.compileReject) {
    assert.equal(root, 0, 'invalid graph was accepted');
    assert.match(error(first), new RegExp(job.compileReject));
    return {
      status: 'PASS',
      phase: 'compile-rejection',
      error: error(first),
      wasmSha256: sha256(bytes),
    };
  }
  if (!root)
    return {
      status: 'UNSUPPORTED',
      phase: 'compile',
      error: error(first),
      wasmSha256: sha256(bytes),
    };
  const sourceBytes = job.graph.modules.reduce(
    (sum, item) => sum + Buffer.byteLength(item.source),
    0,
  );
  assert.equal(first.source_buffers_wiped(), job.graph.modules.length);
  assert.equal(first.linked_module_roots(), job.graph.modules.length);
  assert.equal(first.source_bytes_wiped(), sourceBytes);
  assert.ok(first.source_capacity_wiped() >= sourceBytes);
  new Uint8Array(first.memory.buffer, pointer, input.byteLength).fill(0);
  input.fill(0);
  const checkpoint = new Uint8Array(first.memory.buffer).slice();
  const sourceMarker = job.sourceMarker
    ? {
        asciiFound: Buffer.from(checkpoint).includes(Buffer.from(job.sourceMarker, 'utf8')),
        utf16Found: Buffer.from(checkpoint).includes(Buffer.from(job.sourceMarker, 'utf16le')),
      }
    : undefined;
  if (sourceMarker) {
    assert.equal(first.source_retention_disabled(), 1, 'source-removal feature must be enabled');
    assert.equal(sourceMarker.asciiFound, false, 'source-only ASCII comment survived checkpoint');
    assert.equal(sourceMarker.utf16Found, false, 'source-only UTF16 comment survived checkpoint');
  }
  const globals = Object.entries(first)
    .filter(([, value]) => value instanceof WebAssembly.Global)
    .map(([name, value]) => ({ name, value: value.value }));
  const tableLength = first.__indirect_function_table.length;
  const second = instantiate();
  assert.equal(second.compile_calls(), 0);
  assert.equal(second.root_pointer(), 0);
  assert.equal(second.__indirect_function_table.length, tableLength);
  const pages = (checkpoint.byteLength - second.memory.buffer.byteLength) / 65536;
  assert.ok(Number.isInteger(pages) && pages >= 0);
  if (pages) second.memory.grow(pages);
  new Uint8Array(second.memory.buffer).set(checkpoint);
  for (const global of globals) {
    if (second[global.name].value !== global.value) second[global.name].value = global.value;
  }
  assert.equal(second.root_pointer(), root);
  assert.equal(second.compile_calls(), 1);
  assert.equal(second.execute_calls(), 0);
  assert.ok(
    new Uint8Array(second.memory.buffer, pointer, input.byteLength).every((byte) => byte === 0),
  );
  const status = second.invoke_json(); // Fresh instance receives no source or AST input.
  assert.equal(second.compile_calls(), 1);
  assert.equal(second.execute_calls(), 1);
  if (job.invokeReject) {
    assert.equal(status, 0);
    assert.match(error(second), new RegExp(job.invokeReject));
    return {
      status: 'PASS',
      phase: 'invoke-rejection',
      error: error(second),
      wasmSha256: sha256(bytes),
    };
  }
  if (status !== 1) {
    const message = error(second);
    return {
      status: /RESULT_UNSUPPORTED|requires a settled promise/.test(message)
        ? 'UNSUPPORTED'
        : 'FAIL',
      phase: 'invoke',
      error: message,
      wasmSha256: sha256(bytes),
    };
  }
  const json = JSON.parse(readText(second, second.result_ptr(), second.result_len()));
  assert.ok(
    Object.is(resultValue(json), job.expected),
    `unexpected result ${JSON.stringify(json)}`,
  );
  if (job.executedMarker) assert.equal(second.guest_marker(), 1);
  return {
    status: 'PASS',
    phase: 'restored-invoke',
    result: json,
    wasmSha256: sha256(bytes),
    checkpointSha256: sha256(checkpoint),
    checkpointBytes: checkpoint.length,
    compileCalls: second.compile_calls(),
    executeCalls: second.execute_calls(),
    modules: job.graph.modules.length,
    sourceBytes,
    sourceBuffersWiped: second.source_buffers_wiped(),
    sourceCapacityWiped: second.source_capacity_wiped(),
    linkedModuleRoots: second.linked_module_roots(),
    registeredUnusedModules: job.registeredUnusedModules ?? [],
    sourceRetentionDisabled: second.source_retention_disabled(),
    sourceMarker,
    inputZeroed: true,
    globals,
    globalInventory,
    tableLength,
    note: 'Trusted same-build memory image, not portable or untrusted bytecode. ABI compile_calls does not instrument internal lazy compilation.',
  };
}

async function loadSuite(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.cases.length, 20, 'the permanent suite denominator must remain 20');
  assert.equal(new Set(manifest.cases.map((item) => item.file)).size, 20);
  for (const item of manifest.cases) {
    assert.match(item.file, /^\d\d-[a-z0-9-]+\.mjs$/);
    assert.ok(['number', 'boolean', 'string'].includes(typeof item.expected));
  }
  const files = (await readdir(directory)).filter((file) => file.endsWith('.mjs')).sort();
  assert.ok(files.length <= 128);
  const modules = [];
  const sourceHashes = {};
  for (const file of files) {
    assert.match(file, /^\d\d-[a-z0-9-]+\.mjs$/);
    const bytes = await readFile(path.join(directory, file));
    assert.ok(bytes.length <= 1_048_576);
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    modules.push({ id: `/${file}`, source });
    sourceHashes[`/${file}`] = sha256(bytes);
  }
  const totalSourceBytes = modules.reduce((sum, item) => sum + Buffer.byteLength(item.source), 0);
  assert.ok(totalSourceBytes <= 8_388_608);
  for (const item of manifest.cases)
    assert.ok(modules.some((module) => module.id === `/${item.file}`));
  const packed = JSON.parse(
    await readFile(new URL('./fixture-graphs.json', import.meta.url), 'utf8'),
  );
  assert.equal(packed.cases.length, 20);
  const cases = manifest.cases.map((fixture, index) => {
    const entry = packed.cases[index];
    assert.equal(entry.name, fixture.file);
    assert.equal(entry.feature, fixture.feature);
    assert.ok(Object.is(entry.expected, fixture.expected));
    assert.equal(entry.graph.format, 'JOVLT-BOA-INPUT0');
    assert.equal(entry.graph.entry, `/${fixture.file}`);
    assert.ok(entry.graph.modules.length > 0 && entry.graph.modules.length <= 128);
    for (const item of entry.graph.modules) {
      assert.equal(item.source, modules.find((module) => module.id === item.id)?.source);
    }
    return {
      name: entry.name,
      feature: entry.feature,
      expected: entry.expected,
      graph: entry.graph,
      registeredUnusedModules: [],
    };
  });
  return { manifest, modules, sourceHashes, totalSourceBytes, cases };
}

function extras() {
  const single = (source) => ({
    format: 'JOVLT-BOA-INPUT0',
    entry: '/main.mjs',
    modules: [{ id: '/main.mjs', source }],
  });
  const marker = 'JOVLT_GRAPH_SOURCE_ONLY_COMMENT_7d613a9691744c1ab4c0815ba2911de3';
  const escaped = single('export function main() { return "\ud83d\ude00"; }');
  const bmp = single('export function main() { return "雪"; }');
  return [
    {
      name: 'unknown-static-import',
      graph: single('import "./missing.mjs"; export function main() { return 1; }'),
      compileReject: 'Module could not be found',
    },
    {
      name: 'unknown-dynamic-import',
      graph: single('export async function main() { return import("./missing.mjs"); }'),
      invokeReject: 'Module could not be found',
    },
    {
      name: 'no-ambient-process-fetch',
      graph: single(
        'export function main() { return typeof process === "undefined" && typeof fetch === "undefined"; }',
      ),
      expected: true,
    },
    {
      name: 'known-dynamic-import',
      graph: {
        ...single('export async function main() { return (await import("./known.mjs")).value; }'),
        modules: [
          {
            id: '/main.mjs',
            source: 'export async function main() { return (await import("./known.mjs")).value; }',
          },
          { id: '/known.mjs', source: 'export const value = 9;' },
        ],
      },
      expected: 9,
    },
    {
      name: 'source-comment-erasure-and-no-execution',
      graph: single(
        `// ${marker}\nglobalThis.__executed = 1; export function main() { return 41; }`,
      ),
      expected: 41,
      sourceMarker: marker,
      executedMarker: true,
    },
    {
      name: 'escaped-unicode-source',
      graph: escaped,
      rawInput: JSON.stringify(escaped).replace('😀', '\\ud83d\\ude00'),
      expected: '😀',
    },
    {
      name: 'escaped-bmp-source',
      graph: bmp,
      rawInput: JSON.stringify(bmp).replace('雪', '\\u96ea'),
      expected: '雪',
    },
    {
      name: 'crlf-and-escaped-literal-source',
      graph: single('export function main() {\r\n return "line\\n\\\"quote\\\\tail";\r\n}\r\n'),
      expected: 'line\n"quote\\tail',
    },
    {
      name: 'lone-surrogate-source-denied',
      graph: single('export function main() { return 1; } //\ud800'),
      compileReject: 'INPUT_SOURCE',
    },
    {
      name: 'lone-surrogate-guest-string-result',
      graph: single('export function main() { return "\\ud800"; }'),
      expected: '\ud800',
    },
    {
      name: 'namespace-and-reexport-live-binding',
      graph: {
        format: 'JOVLT-BOA-INPUT0',
        entry: '/main.mjs',
        modules: [
          {
            id: '/main.mjs',
            source:
              'import * as ns from "./barrel.mjs"; export function main() { ns.bump(); return ns.value; }',
          },
          { id: '/barrel.mjs', source: 'export { value, bump } from "./state.mjs";' },
          { id: '/state.mjs', source: 'export let value = 1; export function bump() { value++; }' },
        ],
      },
      expected: 2,
    },
    {
      name: 'side-effect-module-order',
      graph: {
        format: 'JOVLT-BOA-INPUT0',
        entry: '/main.mjs',
        modules: [
          {
            id: '/main.mjs',
            source:
              'import "./a.mjs"; import "./b.mjs"; globalThis.order.push("main"); export function main() { return globalThis.order.join(","); }',
          },
          { id: '/a.mjs', source: 'globalThis.order = ["a"];' },
          { id: '/b.mjs', source: 'import "./a.mjs"; globalThis.order.push("b");' },
        ],
      },
      expected: 'a,b,main',
    },
    {
      name: 'top-level-await-dependency',
      graph: {
        format: 'JOVLT-BOA-INPUT0',
        entry: '/main.mjs',
        modules: [
          {
            id: '/main.mjs',
            source: 'import { value } from "./await.mjs"; export function main() { return value; }',
          },
          { id: '/await.mjs', source: 'export const value = await Promise.resolve(7);' },
        ],
      },
      expected: 7,
    },
    {
      name: 'top-level-await-cycle-rejection',
      graph: {
        format: 'JOVLT-BOA-INPUT0',
        entry: '/main.mjs',
        modules: [
          {
            id: '/main.mjs',
            source:
              'import { value } from "./cycle.mjs"; export const ready = await Promise.resolve(1); export function main() { return value; }',
          },
          {
            id: '/cycle.mjs',
            source:
              'import "./main.mjs"; export const value = await Promise.reject(new Error("TLA_CYCLE_REJECT"));',
          },
        ],
      },
      invokeReject: 'TLA_CYCLE_REJECT',
    },
    {
      name: 'registered-unused-module-prelinked',
      graph: {
        format: 'JOVLT-BOA-INPUT0',
        entry: '/main.mjs',
        modules: [
          { id: '/main.mjs', source: 'export function main() { return 3; }' },
          {
            id: '/unused.mjs',
            source: 'throw new Error("UNUSED_MUST_NOT_EVALUATE"); export const value = 1;',
          },
        ],
      },
      registeredUnusedModules: ['/unused.mjs'],
      expected: 3,
    },
    {
      name: 'duplicate-module-identity',
      graph: {
        ...single('export function main() { return 1; }'),
        modules: [
          { id: '/main.mjs', source: '' },
          { id: '/main.mjs', source: '' },
        ],
      },
      compileReject: 'INPUT_SCHEMA',
    },
    {
      name: 'duplicate-json-field',
      rawInput:
        '{"format":"JOVLT-BOA-INPUT0","format":"JOVLT-BOA-INPUT0","entry":"/main.mjs","modules":[]}',
      compileReject: 'INPUT_SCHEMA',
    },
    {
      name: 'noncanonical-module-identity',
      graph: { ...single(''), entry: '/a/../main.mjs' },
      compileReject: 'INPUT_SCHEMA',
    },
    {
      name: 'unknown-graph-field',
      graph: { ...single(''), extra: true },
      compileReject: 'INPUT_SCHEMA',
    },
  ];
}

if (!isMainThread) {
  try {
    parentPort.postMessage(await runFixture(workerData));
  } catch (error) {
    parentPort.postMessage({ status: 'FAIL', phase: 'probe', error: String(error.stack ?? error) });
  }
} else {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index === -1) return fallback;
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'));
    return path.resolve(args[index + 1]);
  };
  const wasm = option('--wasm', defaultWasm);
  const fixtures = option('--fixtures', defaultFixtures);
  const output = option(
    '--output',
    fileURLToPath(new URL('./graph-results.json', import.meta.url)),
  );
  const suite = await loadSuite(fixtures);
  if (args.includes('--check-inputs')) {
    const inventory = {
      status: 'INPUTS_CHECKED_ONLY',
      denominator: 20,
      modules: suite.modules.length,
      totalSourceBytes: suite.totalSourceBytes,
      sourceHashes: suite.sourceHashes,
      modulesPerCase: suite.cases.map((item) => item.graph.modules.length),
      wasmExecuted: false,
    };
    await writeFile(
      new URL('./input-inventory.json', import.meta.url),
      JSON.stringify(inventory, null, 2) + '\n',
    );
    console.log(JSON.stringify(inventory));
  } else {
    const cases = suite.cases;
    const run = async (job) =>
      new Promise((resolve) => {
        const worker = new Worker(new URL(import.meta.url), {
          workerData: { ...job, wasm },
          resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 8 },
        });
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          void worker.terminate();
          resolve({ name: job.name, feature: job.feature, ...result });
        };
        const timer = setTimeout(
          () => finish({ status: 'FAIL', phase: 'timeout', error: 'worker exceeded 15 seconds' }),
          15000,
        );
        worker.once('message', finish);
        worker.once('error', (error) =>
          finish({ status: 'FAIL', phase: 'worker', error: String(error) }),
        );
        worker.once('exit', (code) => {
          if (!settled)
            finish({ status: 'FAIL', phase: 'worker-exit', error: `exit ${code} without result` });
        });
      });
    const results = [];
    const negativeAndBoundaryResults = [];
    for (const job of cases) {
      const result = await run(job);
      results.push(result);
      console.log(JSON.stringify(result));
    }
    for (const job of extras()) {
      const result = await run(job);
      negativeAndBoundaryResults.push(result);
      console.log(JSON.stringify(result));
    }
    const counts = { PASS: 0, FAIL: 0, UNSUPPORTED: 0 };
    for (const result of results) counts[result.status]++;
    const report = {
      denominator: 20,
      counts,
      fixtureTarget: suite.manifest.target,
      kind: suite.manifest.kind,
      sourceHashes: suite.sourceHashes,
      results,
      negativeAndBoundaryResults,
      limitations:
        'Self-authored feature probes, not Test262 coverage, portable bytecode, production signed loader integration or full JavaScript compatibility.',
    };
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ denominator: 20, counts, output }));
    if (counts.PASS !== 20 || negativeAndBoundaryResults.some((result) => result.status !== 'PASS'))
      process.exitCode = 1;
  }
}
