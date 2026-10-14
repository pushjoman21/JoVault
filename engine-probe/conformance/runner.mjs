import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { executeCheckpoint } from './checkpoint.mjs';

export function controls(globalScripts, sentinel) {
  const single = (source, scripts = globalScripts) => ({
    format: 'JOVLT-BOA-INPUT1',
    entry: '/main.mjs',
    globalScripts: scripts,
    modules: [{ id: '/main.mjs', source }],
  });
  const controlScript = {
    id: '/__harness/control.js',
    source: 'var globalScriptRuns=0; globalScriptRuns++; function sloppyThis(){return this;}',
  };
  const valid = single('export function main(){return 1;}');
  return [
    {
      name: 'positive-global-script-realm-and-once',
      expected: sentinel,
      invokeTwice: true,
      graph: single(
        `assert.sameValue(assert,globalThis.assert); assert.sameValue(Test262Error,globalThis.Test262Error); assert.sameValue(sloppyThis(),globalThis); assert.sameValue(Object.getOwnPropertyDescriptor(globalThis,'globalScriptRuns').enumerable,true); assert.sameValue(globalScriptRuns,1); globalThis.__executed=1; export function main(){assert.sameValue(globalScriptRuns,1);return ${sentinel};}`,
        [...globalScripts, controlScript],
      ),
    },
    {
      name: 'negative-assertion-is-failure',
      invokeReject: '^Test262Error\\b[\\s\\S]*KNOWN_ASSERTION_FAILURE',
      graph: single(
        'assert.sameValue(1,2,"KNOWN_ASSERTION_FAILURE"); export function main(){return 1;}',
      ),
    },
    {
      name: 'negative-parse-error-is-failure',
      compileReject: 'SyntaxError',
      graph: single('export const invalid = ;'),
    },
    {
      name: 'negative-missing-harness-is-failure',
      invokeReject: 'ReferenceError:.*assert',
      graph: single('assert.sameValue(1,1); export function main(){return 1;}', []),
    },
    {
      name: 'global-script-failure-latches-instance',
      invokeReject: 'GLOBAL_INIT_FAILURE',
      globalFailureLatch: true,
      expectedEvaluations: 1,
      graph: single('export function main(){throw new Error("MODULE_MUST_NOT_EXECUTE");}', [
        { id: '/__harness/failing.js', source: 'throw new Error("GLOBAL_INIT_FAILURE");' },
      ]),
    },
    {
      name: 'ordered-independent-global-scripts',
      expected: sentinel,
      graph: single(
        `assert.sameValue(order.join(','),'a,b'); export function main(){return ${sentinel};}`,
        [
          ...globalScripts,
          { id: '/__harness/first.js', source: 'var order=["a"];' },
          { id: '/__harness/second.js', source: 'order.push("b");' },
        ],
      ),
    },
    {
      name: 'input0-does-not-accept-new-fields',
      compileReject: 'INPUT_SCHEMA',
      graph: { ...valid, format: 'JOVLT-BOA-INPUT0', globalScripts: [] },
    },
    {
      name: 'input1-requires-global-script-list',
      compileReject: 'INPUT_SCHEMA',
      graph: { format: 'JOVLT-BOA-INPUT1', entry: '/main.mjs', modules: valid.modules },
    },
    {
      name: 'null-is-not-an-absent-global-list',
      compileReject: 'INPUT_SCHEMA',
      graph: { ...valid, globalScripts: null },
    },
    {
      name: 'duplicate-global-identities',
      compileReject: 'INPUT_SCHEMA',
      graph: { ...valid, globalScripts: [controlScript, controlScript] },
    },
    {
      name: 'global-module-identity-collision',
      compileReject: 'INPUT_SCHEMA',
      graph: { ...valid, globalScripts: [{ id: '/main.mjs', source: '' }] },
    },
    {
      name: 'global-script-count-bound',
      compileReject: 'INPUT_SCHEMA',
      graph: {
        ...valid,
        globalScripts: Array.from({ length: 17 }, (_, index) => ({
          id: `/s${index}.js`,
          source: '',
        })),
      },
    },
    {
      name: 'combined-source-count-bound',
      compileReject: 'INPUT_SCHEMA',
      graph: {
        ...valid,
        globalScripts: [controlScript],
        modules: Array.from({ length: 128 }, (_, index) => ({
          id: index ? `/m${index}.mjs` : '/main.mjs',
          source: '',
        })),
      },
    },
    {
      name: 'global-source-byte-bound',
      compileReject: 'INPUT_SOURCE_SIZE',
      graph: { ...valid, globalScripts: [{ id: '/large.js', source: ' '.repeat(1048577) }] },
    },
  ];
}

export function runWorker(job, deadlineMs) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 8 },
    });
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ name: job.name, ...result });
    };
    const timer = setTimeout(
      () => finish({ status: 'TIMEOUT', phase: 'worker', deadlineMs }),
      deadlineMs,
    );
    worker.once('message', finish);
    worker.once('error', (error) =>
      finish({ status: 'RUNNER_ERROR', error: String(error.stack ?? error) }),
    );
    worker.once('exit', (code) => {
      if (!finished)
        finish({ status: 'RUNNER_ERROR', error: `worker exited ${code} without completion` });
    });
  });
}

if (!isMainThread) {
  try {
    parentPort.postMessage(await executeCheckpoint(workerData));
  } catch (error) {
    parentPort.postMessage({
      status: 'RUNNER_ERROR',
      phase: 'contract-assertion',
      error: String(error.stack ?? error),
    });
  }
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : path.resolve(args[index + 1]);
  };
  const wasm = option(
    '--wasm',
    fileURLToPath(
      new URL(
        '../target/wasm32-unknown-unknown/release/jovault_boa_snapshot_probe.wasm',
        import.meta.url,
      ),
    ),
  );
  const output = option('--output', null);
  if (!output)
    throw new Error('Usage: node runner.mjs [--wasm file.wasm] --output NEW-report.json');
  const bundle = JSON.parse(await readFile(new URL('cases.json', import.meta.url), 'utf8'));
  const classification = JSON.parse(
    await readFile(new URL('classification-summary.json', import.meta.url), 'utf8'),
  );
  const profile = JSON.parse(await readFile(new URL('profile.json', import.meta.url), 'utf8'));
  assert.deepEqual(bundle.profile, profile);
  assert.ok(Number.isSafeInteger(profile.selectedLimit) && profile.selectedLimit > 0);
  assert.equal(bundle.cases.length, profile.selectedLimit);
  assert.equal(classification.selected, profile.selectedLimit);
  assert.deepEqual(bundle.cases.map((entry) => entry.name), profile.selectedPaths);
  assert.equal(new Set(profile.selectedPaths).size, profile.selectedLimit);
  assert.equal(bundle.profile.workerDeadlineMs, 5000);
  const globalScripts = bundle.cases[0].graph.globalScripts;
  const controlResults = [];
  for (const control of controls(globalScripts, bundle.profile.driverSentinel)) {
    const result = await runWorker({ ...control, wasm }, 5000);
    controlResults.push(result);
    console.log(JSON.stringify({ kind: 'control', ...result }));
    if (result.status === 'BLOCKED_ABI') break;
  }
  const controlsPassed =
    controlResults.length === controls(globalScripts, bundle.profile.driverSentinel).length &&
    controlResults.every((result) => result.status === 'PASS');
  const results = [];
  for (const job of bundle.cases) {
    const result = controlsPassed
      ? await runWorker({ ...job, wasm }, 5000)
      : {
          name: job.name,
          status: controlResults.some((result) => result.status === 'BLOCKED_ABI')
            ? 'BLOCKED_ABI'
            : 'NOT_RUN',
          phase: 'runner-control-gate',
        };
    results.push(result);
    console.log(JSON.stringify({ kind: 'test262', ...result }));
  }
  const counts = Object.fromEntries(
    ['PASS', 'FAIL', 'UNSUPPORTED', 'TIMEOUT', 'RUNNER_ERROR', 'BLOCKED_ABI', 'NOT_RUN'].map(
      (status) => [status, results.filter((result) => result.status === status).length],
    ),
  );
  const report = {
    profile: bundle.profile,
    pin: bundle.profile.test262Commit,
    selectedDenominator: results.length,
    discoveredDenominator: classification.discovered,
    unselectedNotRun: classification.discovered - results.length,
    counts,
    controlsPassed,
    controlResults,
    results,
    supportHashes: bundle.supportHashes,
    classification: {
      selected: classification.selected,
      eligibleNotSelected: classification.eligibleNotSelected,
      excludedFromInitialSlice: classification.excludedFromInitialSlice,
      primaryReasons: classification.primaryReasons,
    },
    note: 'Reviewed module-positive synchronous Test262 profile. No whole-suite/ES2025 coverage rate. No Node guest source execution. Fresh compile and restored WASM instances per case; five-second external deadline. Trusted same-build checkpoint is not a portable/untrusted bytecode package.',
  };
  assert.equal(
    Object.values(counts).reduce((sum, value) => sum + value, 0),
    results.length,
  );
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ counts, controlsPassed, output }));
  if (!controlsPassed || counts.PASS !== results.length) process.exitCode = 1;
}
