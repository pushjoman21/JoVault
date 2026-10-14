// Trusted exact-image regression probe. Guest source executes only in Boa Wasm.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomFillSync } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function run(job) {
  const bytes = await readFile(job.wasm);
  const module = await WebAssembly.compile(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: 'probe', name: 'entropy', kind: 'function' },
  ]);
  function instantiate() {
    let instance;
    instance = new WebAssembly.Instance(module, {
      probe: {
        entropy(pointer, length) {
          assert.ok(
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
  const input = new TextEncoder().encode(JSON.stringify(job.graph));
  const pointer = first.alloc_input(input.length);
  assert.ok(pointer > 0);
  const stack = first.__stack_pointer.value;
  new Uint8Array(first.memory.buffer, pointer, input.length).set(input);
  assert.ok(first.compile_graph(pointer, input.length) > 0);
  new Uint8Array(first.memory.buffer, pointer, input.length).fill(0);
  input.fill(0);
  assert.equal(first.compile_calls(), 1);
  assert.equal(first.execute_calls(), 0);
  assert.equal(first.remaining_instructions(), 200000);
  assert.equal(first.source_retention_disabled(), 1);
  assert.equal(first.__stack_pointer.value, stack);
  const image = new Uint8Array(first.memory.buffer).slice();
  const second = instantiate();
  const pages = (image.length - second.memory.buffer.byteLength) / 65536;
  assert.ok(Number.isInteger(pages) && pages >= 0);
  if (pages) second.memory.grow(pages);
  assert.equal(second.__indirect_function_table.length, first.__indirect_function_table.length);
  new Uint8Array(second.memory.buffer).set(image);
  second.__stack_pointer.value = stack;
  assert.equal(second.compile_calls(), 1);
  assert.equal(second.execute_calls(), 0);
  const status = second.invoke_json();
  const text = (pointer, length) =>
    new TextDecoder('utf-8', { fatal: true }).decode(
      new Uint8Array(second.memory.buffer, pointer, length),
    );
  assert.equal(status, 1, text(second.error_ptr(), second.error_len()));
  assert.deepEqual(JSON.parse(text(second.result_ptr(), second.result_len())), {
    type: 'boolean',
    value: true,
  });
  assert.equal(second.compile_calls(), 1);
  assert.equal(second.execute_calls(), 1);
  return { name: job.name, status: 'PASS', wasmSha256: sha(bytes), result: true };
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
} else {
  const cases = JSON.parse(
    await readFile(new URL('./fixture-class-names.json', import.meta.url), 'utf8'),
  ).cases;
  assert.equal(cases.length, 11);
  assert.equal(new Set(cases.map((test) => test.name)).size, cases.length);
  if (process.argv.includes('--check-cases'))
    console.log(JSON.stringify({ cases: cases.length, wasmExecuted: false }));
  else {
    const index = process.argv.indexOf('--wasm');
    assert.ok(index >= 0 && process.argv[index + 1], '--wasm <exact build> is required');
    const wasm = process.argv[index + 1];
    const results = [];
    for (const test of cases)
      results.push(
        await new Promise((resolve) => {
          const worker = new Worker(new URL(import.meta.url), {
            workerData: { ...test, wasm },
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
            () => finish({ name: test.name, status: 'FAIL', error: 'worker deadline 15s' }),
            15000,
          );
          worker.once('message', finish);
          worker.once('error', (error) =>
            finish({ name: test.name, status: 'FAIL', error: String(error) }),
          );
          worker.once('exit', (code) => {
            if (!settled) finish({ name: test.name, status: 'FAIL', error: `worker exit ${code}` });
          });
        }),
      );
    const report = {
      wasmSha256: sha(await readFile(wasm)),
      cases: results.length,
      pass: results.filter((r) => r.status === 'PASS').length,
      fail: results.filter((r) => r.status !== 'PASS').length,
      results,
    };
    const out = process.argv.indexOf('--output');
    await writeFile(
      out >= 0
        ? process.argv[out + 1]
        : fileURLToPath(new URL('./class-name-results.json', import.meta.url)),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report));
    if (report.fail) process.exitCode = 1;
  }
}
