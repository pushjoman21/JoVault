import { parentPort, workerData } from 'node:worker_threads';
import {
  captureBoaCheckpoint,
  createBoaInstance,
  encodeBoaCheckpoint,
  prepareBoaRuntime,
  readBoaResult,
  type TrustedBoaRuntime,
} from './boa-checkpoint.js';
import {
  BOA_COMPILER_LIMITS,
  BoaCompilerError,
  snapshotBoaCompilerGraph,
  snapshotExportNames,
  type BoaCompilerJob,
} from './boa-compiler-node.js';

function reject(code: string): never {
  throw new BoaCompilerError(code);
}

async function compile(job: BoaCompilerJob) {
  const graph = snapshotBoaCompilerGraph(job.graph);
  let runtime: TrustedBoaRuntime;
  try {
    runtime = await prepareBoaRuntime(
      job.runtime.wasmBytes,
      job.runtime.auditBytes,
      job.runtime.policy,
    );
  } catch {
    return reject('BOA_COMPILER_PROFILE');
  }
  const instance = createBoaInstance(runtime);
  const initialStack = instance.__stack_pointer.value;
  if (
    instance.compile_calls() !== 0 ||
    instance.execute_calls() !== 0 ||
    instance.source_retention_disabled() !== 1 ||
    instance.instruction_budget_enabled() !== 1
  )
    reject('BOA_COMPILER_ABI');
  const encoded = new TextEncoder().encode(
    JSON.stringify({ format: 'JOVLT-BOA-INPUT0', ...graph }),
  );
  if (encoded.byteLength > BOA_COMPILER_LIMITS.inputBytes) reject('BOA_COMPILER_SIZE');
  let pointer = 0;
  let rootPointer = 0;
  try {
    pointer = instance.alloc_input(encoded.byteLength);
    if (
      !Number.isInteger(pointer) ||
      pointer < 1 ||
      pointer + encoded.byteLength > instance.memory.buffer.byteLength
    )
      reject('BOA_COMPILER_ABI');
    new Uint8Array(instance.memory.buffer, pointer, encoded.byteLength).set(encoded);
    rootPointer = instance.compile_graph(pointer, encoded.byteLength);
  } finally {
    if (pointer > 0 && pointer + encoded.byteLength <= instance.memory.buffer.byteLength)
      new Uint8Array(instance.memory.buffer, pointer, encoded.byteLength).fill(0);
    encoded.fill(0);
  }
  if (rootPointer === 0) reject('BOA_COMPILER_REJECTED');
  if (
    instance.compile_calls() !== 1 ||
    instance.execute_calls() !== 0 ||
    instance.root_pointer() !== rootPointer ||
    instance.remaining_instructions() !== BOA_COMPILER_LIMITS.instructionBudget ||
    instance.source_buffers_wiped() !== graph.modules.length ||
    instance.linked_module_roots() !== graph.modules.length ||
    instance.__stack_pointer.value !== initialStack
  )
    reject('BOA_COMPILER_ABI');
  if (instance.export_names_json() !== 1) reject('BOA_COMPILER_REJECTED');
  const exportNames = snapshotExportNames(readBoaResult(instance));
  if (
    instance.execute_calls() !== 0 ||
    instance.remaining_instructions() !== BOA_COMPILER_LIMITS.instructionBudget ||
    instance.__stack_pointer.value !== initialStack
  )
    reject('BOA_COMPILER_ABI');
  // A full 64 MiB image cannot fit inside P1 once its checkpoint header is added.
  if (instance.memory.buffer.byteLength >= BOA_COMPILER_LIMITS.inputBytes)
    reject('BOA_COMPILER_SIZE');
  const payload = encodeBoaCheckpoint(captureBoaCheckpoint(instance));
  return { payload, exportNames };
}

if (parentPort !== null) {
  try {
    const result = await compile(workerData as BoaCompilerJob);
    parentPort.postMessage({ ok: true, value: result }, [result.payload.buffer]);
  } catch (error) {
    // Diagnostics may include source excerpts. Only stable codes cross this boundary.
    const code =
      error instanceof BoaCompilerError
        ? error.code
        : error instanceof WebAssembly.RuntimeError
          ? 'BOA_COMPILER_TRAP'
          : 'BOA_COMPILER_WORKER';
    parentPort.postMessage({ ok: false, value: code });
  }
}
