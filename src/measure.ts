import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileModule } from './register-compiler.js';
import { instantiate } from './register-runtime.js';

const hash = (source: string): string => createHash('sha256').update(source).digest('hex');
const median = (samples: number[]): number =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

/** Synthetic local pilot. Does not measure browser or analyst resistance. */
export async function measure(): Promise<Record<string, unknown>> {
  const directory = mkdtempSync(join(tmpdir(), 'jovault-measure-'));
  const results: Record<string, unknown>[] = [];
  try {
    for (const statements of [0, 100, 2500]) {
      const source =
        statements === 0
          ? 'export function main(x) { return x + 1; }\n'
          : `export function main(x) {\nlet value = x | 0;\n${Array.from({ length: statements }, (_, i) => `value = (value + ${i % 31}) | 0;`).join('\n')}\nreturn value;\n}\n`;
      const path = join(directory, `case-${statements}.mjs`);
      writeFileSync(path, source);
      const loaded: unknown = await import(pathToFileURL(path).href);
      if (
        !loaded ||
        typeof loaded !== 'object' ||
        !('main' in loaded) ||
        typeof loaded.main !== 'function'
      )
        throw new Error('NATIVE_FIXTURE');
      const native = loaded.main as (value: number) => number;
      const now = Date.now();
      const compileMs: number[] = [];
      let compilation = compileModule(source, { now, variant: 'cost-pilot' });
      // One warm-up before seven recorded samples. Native and VM receive the same input.
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        compilation = compileModule(source, { now, variant: 'cost-pilot' });
        compileMs.push(performance.now() - start);
      }
      const vm = instantiate(compilation.artifact, compilation.dialect);
      assert.equal(vm.invoke('main', [123]), native(123));
      const invokeMs: number[] = [];
      const nativeMs: number[] = [];
      const loadMs: number[] = [];
      for (let i = 0; i < 7; i++) {
        let start = performance.now();
        instantiate(compilation.artifact, compilation.dialect);
        loadMs.push(performance.now() - start);
        start = performance.now();
        const actual = vm.invoke('main', [123]);
        invokeMs.push(performance.now() - start);
        start = performance.now();
        const expected = native(123);
        nativeMs.push(performance.now() - start);
        assert.equal(actual, expected);
      }
      results.push({
        statements,
        lines: source.trimEnd().split('\n').length,
        sourceBytes: Buffer.byteLength(source),
        sourceSha256: hash(source),
        artifactBytes: Buffer.byteLength(JSON.stringify(compilation.artifact)),
        instructions: compilation.artifact.functions[0]!.code.length,
        parity: 'PASS',
        samples: { compileMs, loadMs, invokeMs, nativeMs },
        medianMs: {
          compile: median(compileMs),
          load: median(loadMs),
          invoke: median(invokeMs),
          native: median(nativeMs),
        },
      });
    }
  } finally {
    // directory comes directly from mkdtemp under the OS temporary directory.
    rmSync(directory, { recursive: true });
  }
  const implementation = [
    'register-compiler.ts',
    'register-runtime.ts',
    'register-contract.ts',
    'frontend.ts',
    'ir.ts',
  ].map((name) => ({
    path: `src/${name}`,
    sha256: hash(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')),
  }));
  return {
    experiment: 'JV-COST-1-pilot',
    status: 'local synthetic pilot; no release threshold',
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    },
    protocol: {
      warmups: 1,
      samples: 7,
      invocationInput: 123,
      clock: 'real Date.now; no expiry bypass',
      mode: 'serial',
      sourceSizes: [0, 100, 2500],
      timeUnit: 'ms',
    },
    implementation,
    results,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await measure();
    if (process.argv[2])
      writeFileSync(resolve(process.argv[2]), JSON.stringify(result, null, 2) + '\n', {
        flag: 'wx',
      });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'MEASUREMENT_FAILED') + '\n');
    process.exitCode = 1;
  }
}
