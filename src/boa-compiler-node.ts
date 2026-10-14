import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import {
  copyTrustedBoaRuntime,
  decodeBoaCheckpoint,
  type BoaRuntimeTransfer,
  type TrustedBoaRuntime,
} from './boa-checkpoint.js';

export const BOA_COMPILER_LIMITS = Object.freeze({
  modules: 128,
  moduleBytes: 1_048_576,
  totalSourceBytes: 8_388_608,
  inputBytes: 67_108_864,
  deadlineMs: 5_000,
  heapMb: 128,
  instructionBudget: 200_000,
});

export interface BoaCompilerGraph {
  readonly entry: string;
  readonly modules: readonly Readonly<{ id: string; source: string }>[];
}

export interface BoaCompilation {
  readonly payload: Uint8Array<ArrayBuffer>;
  readonly exportNames: readonly string[];
  readonly metadata: Readonly<{
    runtimeSha256: string;
    auditSha256: string;
    abi: 1;
    memoryBytes: number;
    rootPointer: number;
    instructionBudget: 200_000;
    sourceRetentionDisabled: true;
  }>;
}

export interface BoaCompilerJob {
  readonly graph: BoaCompilerGraph;
  readonly runtime: BoaRuntimeTransfer;
}

export class BoaCompilerError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'BoaCompilerError';
  }
}

function fail(code: string): never {
  throw new BoaCompilerError(code);
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    fail('BOA_COMPILER_INPUT');
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail('BOA_COMPILER_INPUT');
  const actual = Reflect.ownKeys(input);
  if (actual.length !== keys.length) fail('BOA_COMPILER_INPUT');
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    if (typeof key !== 'string' || !keys.includes(key)) fail('BOA_COMPILER_INPUT');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      fail('BOA_COMPILER_INPUT');
    copy[key] = descriptor.value as unknown;
  }
  return copy;
}

function moduleId(input: unknown): string {
  if (
    typeof input !== 'string' ||
    input.length > 1024 ||
    !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u.test(input) ||
    input
      .slice(1)
      .split('/')
      .some((part) => part === '.' || part === '..')
  )
    fail('BOA_COMPILER_INPUT');
  return input;
}

function wellFormed(input: string): boolean {
  for (let index = 0; index < input.length; index++) {
    const unit = input.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = input.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/** Snapshots supplied modules only; no filesystem, package or URL resolution. */
export function snapshotBoaCompilerGraph(input: unknown): BoaCompilerGraph {
  try {
    const graph = record(input, ['entry', 'modules']);
    const entry = moduleId(graph.entry);
    const list = graph.modules;
    if (
      !Array.isArray(list) ||
      Object.getPrototypeOf(list) !== Array.prototype ||
      list.length < 1 ||
      list.length > BOA_COMPILER_LIMITS.modules ||
      Reflect.ownKeys(list).length !== list.length + 1
    )
      fail('BOA_COMPILER_INPUT');
    const modules: Readonly<{ id: string; source: string }>[] = [];
    const ids = new Set<string>();
    let bytes = 0;
    for (let index = 0; index < list.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        fail('BOA_COMPILER_INPUT');
      const module = record(descriptor.value, ['id', 'source']);
      const id = moduleId(module.id);
      if (ids.has(id) || typeof module.source !== 'string') fail('BOA_COMPILER_INPUT');
      // Bound UTF-16 length before UTF-8 accounting to avoid scanning huge inputs.
      if (module.source.length > BOA_COMPILER_LIMITS.moduleBytes) fail('BOA_COMPILER_SIZE');
      if (!wellFormed(module.source)) fail('BOA_COMPILER_INPUT');
      const length = Buffer.byteLength(module.source, 'utf8');
      bytes += length;
      if (length > BOA_COMPILER_LIMITS.moduleBytes || bytes > BOA_COMPILER_LIMITS.totalSourceBytes)
        fail('BOA_COMPILER_SIZE');
      ids.add(id);
      modules.push(Object.freeze({ id, source: module.source }));
    }
    if (!ids.has(entry)) fail('BOA_COMPILER_INPUT');
    return Object.freeze({ entry, modules: Object.freeze(modules) });
  } catch (error) {
    if (error instanceof BoaCompilerError) throw error;
    return fail('BOA_COMPILER_INPUT');
  }
}

/** Compiles in a disposable worker. Signing remains in the caller's process. */
export async function compileBoaCheckpoint(
  input: unknown,
  runtime: TrustedBoaRuntime,
): Promise<BoaCompilation> {
  // Both snapshots happen before the first await or asynchronous worker startup.
  const graph = snapshotBoaCompilerGraph(input);
  let transfer: BoaRuntimeTransfer;
  try {
    transfer = copyTrustedBoaRuntime(runtime);
  } catch {
    return fail('BOA_COMPILER_PROFILE');
  }
  const identity = Object.freeze({ ...transfer.policy });
  const bounds = Object.freeze({
    initialPages: runtime.memoryInitialPages,
    maximumPages: runtime.memoryMaximumPages,
    tableLength: runtime.tableLength,
  });
  const job: BoaCompilerJob = { graph, runtime: transfer };
  const temporaryDirectory = tmpdir();
  return new Promise<BoaCompilation>((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (error?: BoaCompilerError, result?: BoaCompilation): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Terminate before resolving; the compile instance has no further work.
      const termination = worker?.terminate() ?? Promise.resolve();
      void termination.then(
        () => (error ? reject(error) : resolve(result!)),
        () => reject(new BoaCompilerError('BOA_COMPILER_WORKER')),
      );
    };
    const timer = setTimeout(
      () => finish(new BoaCompilerError('BOA_COMPILER_TIMEOUT')),
      BOA_COMPILER_LIMITS.deadlineMs,
    );
    try {
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      worker = new Worker(new URL(`./boa-compiler-worker.${extension}`, import.meta.url), {
        workerData: job,
        transferList: [transfer.wasmBytes.buffer, transfer.auditBytes.buffer],
        resourceLimits: { maxOldGenerationSizeMb: BOA_COMPILER_LIMITS.heapMb, stackSizeMb: 8 },
        // A compiled deployment needs no hooks; source development uses tsx's ESM hook.
        execArgv: extension === 'ts' ? ['--import', import.meta.resolve('tsx')] : [],
        // Windows needs an explicit temp path without inheriting the host environment.
        // tsx 4.23.15 uses TSX_DISABLE_CACHE to keep transform results in memory.
        env: {
          TEMP: temporaryDirectory,
          TMP: temporaryDirectory,
          TMPDIR: temporaryDirectory,
          TSX_DISABLE_CACHE: '1',
        },
      });
      worker.once('message', (message: unknown) => {
        try {
          const response = record(message, ['ok', 'value']);
          if (response.ok === false) {
            if (
              typeof response.value !== 'string' ||
              ![
                'BOA_COMPILER_INPUT',
                'BOA_COMPILER_SIZE',
                'BOA_COMPILER_PROFILE',
                'BOA_COMPILER_REJECTED',
                'BOA_COMPILER_ABI',
                'BOA_COMPILER_TRAP',
                'BOA_COMPILER_WORKER',
              ].includes(response.value)
            )
              fail('BOA_COMPILER_WORKER');
            finish(new BoaCompilerError(response.value));
            return;
          }
          if (response.ok !== true) fail('BOA_COMPILER_WORKER');
          const value = record(response.value, ['payload', 'exportNames']);
          if (!(value.payload instanceof Uint8Array)) fail('BOA_COMPILER_WORKER');
          const payload = Uint8Array.from(value.payload);
          const checkpoint = decodeBoaCheckpoint(payload);
          const pages = checkpoint.memory.byteLength / 65536;
          if (
            pages < bounds.initialPages ||
            pages > bounds.maximumPages ||
            checkpoint.tableLength !== bounds.tableLength
          )
            fail('BOA_COMPILER_WORKER');
          const exportNames = snapshotExportNames(value.exportNames);
          finish(
            undefined,
            Object.freeze({
              payload,
              exportNames,
              metadata: Object.freeze({
                runtimeSha256: identity.runtimeSha256,
                auditSha256: identity.auditSha256,
                abi: 1,
                memoryBytes: checkpoint.memory.byteLength,
                rootPointer: checkpoint.rootPointer,
                instructionBudget: 200_000,
                sourceRetentionDisabled: true,
              }),
            }),
          );
        } catch {
          finish(new BoaCompilerError('BOA_COMPILER_WORKER'));
        }
      });
      worker.once('error', () => finish(new BoaCompilerError('BOA_COMPILER_WORKER')));
      worker.once('exit', () => {
        if (!settled) finish(new BoaCompilerError('BOA_COMPILER_WORKER'));
      });
    } catch {
      finish(new BoaCompilerError('BOA_COMPILER_WORKER'));
    }
  });
}

/** Shared bounded metadata check; does not read module bindings. */
export function snapshotExportNames(input: unknown): readonly string[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > 256 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    fail('BOA_COMPILER_ABI');
  const copy: string[] = [];
  const names = new Set<string>();
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      !descriptor ||
      !('value' in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length > 8192 ||
      names.has(descriptor.value)
    )
      fail('BOA_COMPILER_ABI');
    names.add(descriptor.value);
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
}
