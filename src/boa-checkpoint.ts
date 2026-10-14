import {
  MAX_PACKAGE_BYTES,
  readVerifiedPayload,
  snapshotPackagePayload,
  verifyPackage,
  type VerificationKey,
} from './package.js';

export const BOA_CHECKPOINT_VERSION = 1;
export const BOA_MUTABLE_GLOBALS = Object.freeze(['__stack_pointer'] as const);
const MAGIC = new TextEncoder().encode('JOVLTBC1');
const HEADER_BYTES = 32;
const MAX_METADATA_BYTES = 4096;
const PAGE_BYTES = 65536;
const MAX_PAGES = 1024;
const MAX_FUEL = 200_000;
const MAX_RESULT_BYTES = 262144;
const MAX_AUDIT_BYTES = 1_048_576;
const FUNCTIONS = Object.freeze([
  'alloc_input',
  'compile_graph',
  'compile_calls',
  'execute_calls',
  'root_pointer',
  'source_buffers_wiped',
  'source_bytes_wiped',
  'source_capacity_wiped',
  'source_retention_disabled',
  'linked_module_roots',
  'instruction_budget_enabled',
  'remaining_instructions',
  'export_names_json',
  'invoke_json_args',
  'result_ptr',
  'result_len',
  'error_json_ptr',
  'error_json_len',
  'error_ptr',
  'error_len',
] as const);

export type BoaArgument = null | boolean | number | string;
export type BoaValue = BoaArgument | undefined;

export interface BoaRuntimePolicy {
  readonly runtimeSha256: string;
  readonly auditSha256: string;
}
export interface BoaRuntimeTransfer {
  readonly wasmBytes: Uint8Array<ArrayBuffer>;
  readonly auditBytes: Uint8Array<ArrayBuffer>;
  readonly policy: BoaRuntimePolicy;
}
const runtimeBrand: unique symbol = Symbol('trusted-boa-runtime');
export interface TrustedBoaRuntime extends BoaRuntimePolicy {
  readonly [runtimeBrand]: true;
  readonly memoryInitialPages: number;
  readonly memoryMaximumPages: number;
  readonly tableLength: number;
}
export interface BoaCheckpoint {
  readonly memory: Uint8Array<ArrayBuffer>;
  readonly tableLength: number;
  readonly rootPointer: number;
  readonly globals: readonly { readonly name: '__stack_pointer'; readonly value: number }[];
}
export interface BoaAbiExports {
  readonly memory: WebAssembly.Memory;
  readonly __stack_pointer: WebAssembly.Global;
  readonly __indirect_function_table: WebAssembly.Table;
  alloc_input(length: number): number;
  compile_graph(pointer: number, length: number): number;
  compile_calls(): number;
  execute_calls(): number;
  root_pointer(): number;
  source_buffers_wiped(): number;
  source_bytes_wiped(): number;
  source_capacity_wiped(): number;
  source_retention_disabled(): number;
  linked_module_roots(): number;
  instruction_budget_enabled(): number;
  remaining_instructions(): number;
  export_names_json(): number;
  invoke_json_args(pointer: number, length: number): number;
  result_ptr(): number;
  result_len(): number;
  error_json_ptr(): number;
  error_json_len(): number;
  error_ptr(): number;
  error_len(): number;
}
export interface BoaPackageExpectation {
  readonly application: string;
  readonly deployment: string;
  readonly runtimeSha256: string;
}
export interface BoaPackageOptions {
  readonly now?: () => number;
}
export interface BoaPackageInstance {
  readonly exportNames: readonly string[];
  readonly remainingInstructions: number;
  invoke(args?: readonly BoaArgument[]): BoaValue;
}
export class BoaCheckpointError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'BoaCheckpointError';
  }
}
function fail(code: string): never {
  throw new BoaCheckpointError(code);
}
function integer(input: unknown, min: number, max: number, code = 'CHECKPOINT_SCHEMA'): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max)
    fail(code);
  return input;
}
function record(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    fail('CHECKPOINT_SCHEMA');
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail('CHECKPOINT_SCHEMA');
  const actual = Reflect.ownKeys(input);
  if (
    keys &&
    (actual.length !== keys.length ||
      actual.some((key) => typeof key !== 'string' || !keys.includes(key)))
  )
    fail('CHECKPOINT_SCHEMA');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    if (typeof key !== 'string') fail('CHECKPOINT_SCHEMA');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      fail('CHECKPOINT_SCHEMA');
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function array(input: unknown, max: number): unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > max ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    fail('CHECKPOINT_SCHEMA');
  const result: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      fail('CHECKPOINT_SCHEMA');
    result.push(descriptor.value as unknown);
  }
  return result;
}
function hashText(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) fail('RUNTIME_POLICY');
  return input;
}
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)!.get!;
function bytes(input: Uint8Array, max: number): Uint8Array<ArrayBuffer> {
  try {
    const length: unknown = byteLengthGetter.call(input);
    integer(length, 0, max);
    return snapshotPackagePayload(input);
  } catch {
    return fail('CHECKPOINT_SIZE');
  }
}
async function sha256(input: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function parseJson(input: Uint8Array<ArrayBuffer>): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)) as unknown;
  } catch {
    return fail('CHECKPOINT_JSON');
  }
}
interface RuntimeData {
  wasmBytes: Uint8Array<ArrayBuffer>;
  auditBytes: Uint8Array<ArrayBuffer>;
  module: WebAssembly.Module;
  policy: BoaRuntimePolicy;
  initialPages: number;
  maximumPages: number;
  tableLength: number;
  exports: { name: string; kind: WebAssembly.ImportExportKind }[];
}
const runtimes = new WeakMap<object, RuntimeData>();
function runtimeData(runtime: TrustedBoaRuntime): RuntimeData {
  const data = runtimes.get(runtime);
  if (!data) fail('RUNTIME_UNTRUSTED');
  return data;
}
function exportKind(input: unknown): WebAssembly.ImportExportKind {
  switch (input) {
    case 'Func':
      return 'function';
    case 'Memory':
      return 'memory';
    case 'Table':
      return 'table';
    case 'Global':
      return 'global';
    default:
      return fail('AUDIT_GATE');
  }
}
function auditLayout(input: unknown, wasmLength: number) {
  // This consumes an operator-pinned audit artifact, not an untrusted audit assertion.
  const audit = record(input);
  if (
    audit.auditVersion !== 1 ||
    audit.binaryValidated !== true ||
    audit.checkpointStateGatePassed !== true ||
    audit.startFunction !== null ||
    audit.wasmBytes !== wasmLength
  )
    fail('AUDIT_GATE');
  if (
    array(audit.rejectionReasons, 0).length !== 0 ||
    Reflect.ownKeys(record(audit.rejectedOperatorCounts)).length !== 0
  )
    fail('AUDIT_GATE');
  const imports = array(audit.imports, 1);
  if (imports.length !== 1) fail('AUDIT_GATE');
  const imported = record(imports[0]);
  const type = record(imported.type);
  if (
    imported.kind !== 'function' ||
    imported.module !== 'probe' ||
    imported.name !== 'entropy' ||
    type.parameters !== '[I32, I32]' ||
    type.results !== '[]'
  )
    fail('AUDIT_GATE');
  const memories = array(audit.memories, 1);
  const tables = array(audit.tables, 1);
  const globals = array(audit.globals, 1);
  if (memories.length !== 1 || tables.length !== 1 || globals.length !== 1) fail('AUDIT_GATE');
  const memory = record(memories[0]);
  const initialPages = integer(memory.initialPages, 1, MAX_PAGES, 'AUDIT_GATE');
  const maximumPages = integer(memory.maximumPages, initialPages, MAX_PAGES, 'AUDIT_GATE');
  if (
    memory.index !== 0 ||
    memory.memory64 !== false ||
    memory.shared !== false ||
    memory.pageSizeLog2 !== null
  )
    fail('AUDIT_GATE');
  const table = record(tables[0]);
  const tableLength = integer(table.initialElements, 1, 100000, 'AUDIT_GATE');
  if (
    table.index !== 0 ||
    table.maximumElements !== tableLength ||
    table.elementType !== 'funcref' ||
    table.shared !== false ||
    table.table64 !== false ||
    record(table.initializer).mode !== 'null'
  )
    fail('AUDIT_GATE');
  const global = record(globals[0]);
  const names = array(global.exportNames, 1);
  if (
    global.index !== 0 ||
    global.mutable !== true ||
    global.shared !== false ||
    global.valueType !== 'I32' ||
    names.length !== 1 ||
    names[0] !== '__stack_pointer'
  )
    fail('AUDIT_GATE');
  const seen = new Set<string>();
  const exports = array(audit.exports, 256).map((raw) => {
    const entry = record(raw, ['name', 'kind', 'index']);
    if (typeof entry.name !== 'string' || entry.name.length > 128 || seen.has(entry.name))
      fail('AUDIT_GATE');
    seen.add(entry.name);
    integer(entry.index, 0, 1_000_000, 'AUDIT_GATE');
    return { name: entry.name, kind: exportKind(entry.kind) };
  });
  if (
    exports.filter((entry) => entry.kind === 'memory').length !== 1 ||
    exports.filter((entry) => entry.kind === 'table').length !== 1 ||
    exports.filter((entry) => entry.kind === 'global').length !== 1
  )
    fail('AUDIT_GATE');
  for (const [name, kind] of [
    ['memory', 'memory'],
    ['__indirect_function_table', 'table'],
    ['__stack_pointer', 'global'],
    ...FUNCTIONS.map((name) => [name, 'function']),
  ]) {
    if (!exports.some((entry) => entry.name === name && entry.kind === kind)) fail('AUDIT_GATE');
  }
  return { initialPages, maximumPages, tableLength, exports };
}

export async function prepareBoaRuntime(
  wasm: Uint8Array,
  auditBytes: Uint8Array,
  policy: BoaRuntimePolicy,
): Promise<TrustedBoaRuntime> {
  const settings = record(policy, ['runtimeSha256', 'auditSha256']);
  const pinned = Object.freeze({
    runtimeSha256: hashText(settings.runtimeSha256),
    auditSha256: hashText(settings.auditSha256),
  });
  const wasmCopy = bytes(wasm, MAX_PACKAGE_BYTES);
  const auditCopy = bytes(auditBytes, MAX_AUDIT_BYTES);
  const [wasmHash, auditHash] = await Promise.all([sha256(wasmCopy), sha256(auditCopy)]);
  if (wasmHash !== pinned.runtimeSha256) fail('RUNTIME_HASH');
  if (auditHash !== pinned.auditSha256) fail('AUDIT_HASH');
  const layout = auditLayout(parseJson(auditCopy), wasmCopy.length);
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(wasmCopy);
  } catch {
    return fail('RUNTIME_ABI');
  }
  const imports = WebAssembly.Module.imports(module);
  if (
    imports.length !== 1 ||
    imports[0]!.module !== 'probe' ||
    imports[0]!.name !== 'entropy' ||
    imports[0]!.kind !== 'function'
  )
    fail('RUNTIME_ABI');
  const exports = WebAssembly.Module.exports(module);
  if (
    exports.length !== layout.exports.length ||
    exports.some(
      (entry) =>
        !layout.exports.some((item) => item.name === entry.name && item.kind === entry.kind),
    )
  )
    fail('RUNTIME_ABI');
  const runtime: TrustedBoaRuntime = Object.freeze({
    [runtimeBrand]: true as const,
    ...pinned,
    memoryInitialPages: layout.initialPages,
    memoryMaximumPages: layout.maximumPages,
    tableLength: layout.tableLength,
  });
  runtimes.set(runtime, {
    wasmBytes: wasmCopy,
    auditBytes: auditCopy,
    module,
    policy: pinned,
    ...layout,
  });
  return runtime;
}
export function copyTrustedBoaRuntime(runtime: TrustedBoaRuntime): BoaRuntimeTransfer {
  const data = runtimeData(runtime);
  return {
    wasmBytes: new Uint8Array(data.wasmBytes),
    auditBytes: new Uint8Array(data.auditBytes),
    policy: data.policy,
  };
}
const instances = new WeakMap<object, { data: RuntimeData; initialStack: number }>();
function instanceData(instance: BoaAbiExports) {
  const data = instances.get(instance);
  if (!data) fail('RUNTIME_UNTRUSTED');
  return data;
}
export function createBoaInstance(runtime: TrustedBoaRuntime): BoaAbiExports {
  const data = runtimeData(runtime);
  let instance: WebAssembly.Instance | undefined;
  try {
    instance = new WebAssembly.Instance(data.module, {
      probe: {
        entropy(pointer: number, length: number) {
          if (!instance) fail('RUNTIME_ABI');
          const memory = instance.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) fail('RUNTIME_ABI');
          integer(pointer, 0, memory.buffer.byteLength, 'RUNTIME_ABI');
          integer(length, 0, memory.buffer.byteLength - pointer, 'RUNTIME_ABI');
          for (let offset = 0; offset < length; offset += PAGE_BYTES) {
            crypto.getRandomValues(
              new Uint8Array(
                memory.buffer,
                pointer + offset,
                Math.min(PAGE_BYTES, length - offset),
              ),
            );
          }
        },
      },
    });
  } catch (error) {
    if (error instanceof BoaCheckpointError) throw error;
    return fail('RUNTIME_ABI');
  }
  const exports = instance.exports;
  const memory = exports.memory;
  const stack = exports.__stack_pointer;
  const table = exports.__indirect_function_table;
  if (
    !(memory instanceof WebAssembly.Memory) ||
    !(memory.buffer instanceof ArrayBuffer) ||
    memory.buffer.byteLength !== data.initialPages * PAGE_BYTES ||
    !(stack instanceof WebAssembly.Global) ||
    !(table instanceof WebAssembly.Table) ||
    table.length !== data.tableLength
  )
    fail('RUNTIME_ABI');
  const initialStack = integer(stack.value as unknown, 16, memory.buffer.byteLength, 'RUNTIME_ABI');
  if (initialStack % 16 !== 0) fail('RUNTIME_ABI');
  try {
    stack.value = initialStack;
  } catch {
    return fail('RUNTIME_ABI');
  }
  const numeric = (name: (typeof FUNCTIONS)[number]) => {
    const callable = exports[name];
    if (typeof callable !== 'function') fail('RUNTIME_ABI');
    return (...args: number[]): number =>
      integer(callable(...args) as unknown, 0, 0xffffffff, 'RUNTIME_ABI');
  };
  const result: BoaAbiExports = Object.freeze({
    memory,
    __stack_pointer: stack,
    __indirect_function_table: table,
    alloc_input: numeric('alloc_input'),
    compile_graph: numeric('compile_graph'),
    compile_calls: numeric('compile_calls'),
    execute_calls: numeric('execute_calls'),
    root_pointer: numeric('root_pointer'),
    source_buffers_wiped: numeric('source_buffers_wiped'),
    source_bytes_wiped: numeric('source_bytes_wiped'),
    source_capacity_wiped: numeric('source_capacity_wiped'),
    source_retention_disabled: numeric('source_retention_disabled'),
    linked_module_roots: numeric('linked_module_roots'),
    instruction_budget_enabled: numeric('instruction_budget_enabled'),
    remaining_instructions: numeric('remaining_instructions'),
    export_names_json: numeric('export_names_json'),
    invoke_json_args: numeric('invoke_json_args'),
    result_ptr: numeric('result_ptr'),
    result_len: numeric('result_len'),
    error_json_ptr: numeric('error_json_ptr'),
    error_json_len: numeric('error_json_len'),
    error_ptr: numeric('error_ptr'),
    error_len: numeric('error_len'),
  });
  instances.set(result, { data, initialStack });
  return result;
}
function snapshotMetadata(input: unknown, memoryLength: number) {
  const data = record(input, ['tableLength', 'rootPointer', 'globals']);
  const tableLength = integer(data.tableLength, 1, 100000);
  const rootPointer = integer(data.rootPointer, 1, memoryLength - 1);
  const globals = array(data.globals, 1);
  if (globals.length !== 1) fail('CHECKPOINT_SCHEMA');
  const global = record(globals[0], ['name', 'value']);
  const value = integer(global.value, 16, memoryLength);
  if (global.name !== '__stack_pointer' || value % 16 !== 0) fail('CHECKPOINT_SCHEMA');
  return {
    tableLength,
    rootPointer,
    globals: Object.freeze([Object.freeze({ name: '__stack_pointer' as const, value })]),
  };
}
export function encodeBoaCheckpoint(snapshot: BoaCheckpoint): Uint8Array<ArrayBuffer> {
  const input = record(snapshot, ['memory', 'tableLength', 'rootPointer', 'globals']);
  const memory = bytes(input.memory as Uint8Array, MAX_PACKAGE_BYTES);
  if (memory.length === 0 || memory.length % PAGE_BYTES !== 0) fail('CHECKPOINT_SIZE');
  const metadata = snapshotMetadata(
    { tableLength: input.tableLength, rootPointer: input.rootPointer, globals: input.globals },
    memory.length,
  );
  const encoded = new TextEncoder().encode(JSON.stringify(metadata));
  if (
    encoded.length > MAX_METADATA_BYTES ||
    HEADER_BYTES + encoded.length + memory.length > MAX_PACKAGE_BYTES
  )
    fail('CHECKPOINT_SIZE');
  const result = new Uint8Array(HEADER_BYTES + encoded.length + memory.length);
  result.set(MAGIC);
  const header = new DataView(result.buffer);
  header.setUint32(8, BOA_CHECKPOINT_VERSION, true);
  header.setUint32(12, HEADER_BYTES + encoded.length, true);
  header.setUint32(16, memory.length, true);
  header.setUint32(20, encoded.length, true);
  result.set(encoded, HEADER_BYTES);
  result.set(memory, HEADER_BYTES + encoded.length);
  return result;
}
export function decodeBoaCheckpoint(payload: Uint8Array): BoaCheckpoint {
  const input = bytes(payload, MAX_PACKAGE_BYTES);
  if (input.length < HEADER_BYTES || MAGIC.some((byte, index) => input[index] !== byte))
    fail('CHECKPOINT_SCHEMA');
  const header = new DataView(input.buffer);
  const headerBytes = header.getUint32(12, true);
  const memoryBytes = header.getUint32(16, true);
  const metadataBytes = header.getUint32(20, true);
  if (
    header.getUint32(8, true) !== BOA_CHECKPOINT_VERSION ||
    header.getUint32(24, true) !== 0 ||
    header.getUint32(28, true) !== 0 ||
    metadataBytes > MAX_METADATA_BYTES ||
    headerBytes !== HEADER_BYTES + metadataBytes ||
    memoryBytes === 0 ||
    memoryBytes % PAGE_BYTES !== 0 ||
    input.length !== headerBytes + memoryBytes
  )
    fail('CHECKPOINT_SCHEMA');
  const metadata = snapshotMetadata(parseJson(input.slice(HEADER_BYTES, headerBytes)), memoryBytes);
  return Object.freeze({ memory: input.slice(headerBytes), ...metadata });
}
function fuel(instance: BoaAbiExports, positive: boolean): number {
  if (instance.instruction_budget_enabled() !== 1) fail('CHECKPOINT_STATE');
  return integer(instance.remaining_instructions(), positive ? 1 : 0, MAX_FUEL, 'CHECKPOINT_STATE');
}
export function captureBoaCheckpoint(instance: BoaAbiExports): BoaCheckpoint {
  const { data, initialStack } = instanceData(instance);
  if (
    instance.compile_calls() !== 1 ||
    instance.execute_calls() !== 0 ||
    instance.source_retention_disabled() !== 1 ||
    instance.source_buffers_wiped() < 1 ||
    instance.__stack_pointer.value !== initialStack ||
    instance.__indirect_function_table.length !== data.tableLength ||
    instance.memory.buffer.byteLength > data.maximumPages * PAGE_BYTES
  )
    fail('CHECKPOINT_STATE');
  fuel(instance, true);
  const memory = bytes(new Uint8Array(instance.memory.buffer), MAX_PACKAGE_BYTES);
  const metadata = snapshotMetadata(
    {
      tableLength: data.tableLength,
      rootPointer: instance.root_pointer(),
      globals: [{ name: '__stack_pointer', value: initialStack }],
    },
    memory.length,
  );
  if (HEADER_BYTES + MAX_METADATA_BYTES + memory.length > MAX_PACKAGE_BYTES)
    fail('CHECKPOINT_SIZE');
  return Object.freeze({ memory, ...metadata });
}
function readJson(instance: BoaAbiExports, pointer: number, length: number, max: number): unknown {
  instanceData(instance);
  integer(pointer, 0, instance.memory.buffer.byteLength, 'RUNTIME_ABI');
  integer(length, 1, Math.min(max, instance.memory.buffer.byteLength - pointer), 'RUNTIME_ABI');
  return parseJson(new Uint8Array(instance.memory.buffer, pointer, length).slice());
}
export function readBoaResult(instance: BoaAbiExports): unknown {
  return readJson(instance, instance.result_ptr(), instance.result_len(), MAX_RESULT_BYTES);
}
export function readBoaFailure(
  instance: BoaAbiExports,
): 'instruction_budget_exhausted' | 'execution_failed' {
  const failure = record(
    readJson(instance, instance.error_json_ptr(), instance.error_json_len(), 512),
    ['ok', 'error'],
  );
  const error = record(failure.error, ['code']);
  if (
    failure.ok !== false ||
    (error.code !== 'instruction_budget_exhausted' && error.code !== 'execution_failed')
  )
    fail('RUNTIME_ABI');
  return error.code;
}
function checkFailure(instance: BoaAbiExports): never {
  return fail(
    readBoaFailure(instance) === 'instruction_budget_exhausted'
      ? 'INSTRUCTION_BUDGET_EXHAUSTED'
      : 'EXECUTION_FAILED',
  );
}
function primitive(input: unknown): BoaValue {
  const data = record(input);
  if (data.type === 'undefined' || data.type === 'null') {
    record(input, ['type']);
    return data.type === 'undefined' ? undefined : null;
  }
  record(input, ['type', 'value']);
  if (data.type === 'string' && typeof data.value === 'string' && data.value.length <= 8192)
    return data.value;
  if (data.type === 'boolean' && typeof data.value === 'boolean') return data.value;
  if (data.type === 'number') {
    if (typeof data.value === 'number' && Number.isFinite(data.value)) return data.value;
    switch (data.value) {
      case '-0':
        return -0;
      case 'NaN':
        return NaN;
      case 'Infinity':
        return Infinity;
      case '-Infinity':
        return -Infinity;
    }
  }
  return fail('RUNTIME_ABI');
}
function argumentsJson(args: readonly BoaArgument[]): Uint8Array<ArrayBuffer> {
  const snapshot = array(args, 64);
  if (
    snapshot.some(
      (value) =>
        !(
          value === null ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && value.length <= 8192)
        ),
    )
  )
    fail('INVALID_ARGUMENTS');
  // JSON.stringify normalizes -0, so emit that valid numeric spelling explicitly.
  return new TextEncoder().encode(
    '[' +
      snapshot.map((value) => (Object.is(value, -0) ? '-0' : JSON.stringify(value))).join(',') +
      ']',
  );
}
export async function instantiateBoaPackage(
  envelope: unknown,
  payload: Uint8Array,
  trust: readonly VerificationKey[],
  expected: BoaPackageExpectation,
  runtime: TrustedBoaRuntime,
  options: BoaPackageOptions = {},
): Promise<BoaPackageInstance> {
  const data = runtimeData(runtime);
  const context = record(expected, ['application', 'deployment', 'runtimeSha256']);
  if (
    context.runtimeSha256 !== data.policy.runtimeSha256 ||
    typeof context.application !== 'string' ||
    typeof context.deployment !== 'string'
  )
    fail('RUNTIME_POLICY');
  const settings = record(options);
  if (
    Reflect.ownKeys(settings).some((key) => key !== 'now') ||
    ('now' in settings && typeof settings.now !== 'function')
  )
    fail('INVALID_CLOCK');
  const now = (settings.now as (() => number) | undefined) ?? Date.now;
  const verified = await verifyPackage(
    envelope,
    payload,
    trust,
    {
      application: context.application,
      deployment: context.deployment,
      runtimeSha256: data.policy.runtimeSha256,
      kind: 'boa-checkpoint',
      abi: 1,
    },
    { now },
  );
  function checkTime(): void {
    let instant: unknown;
    try {
      instant = now();
    } catch {
      return fail('INVALID_CLOCK');
    }
    if (typeof instant !== 'number' || !Number.isFinite(instant) || instant < 0)
      fail('INVALID_CLOCK');
    if (instant < verified.manifest.notBefore || instant >= verified.manifest.expiresAt)
      fail('EXPIRED');
  }
  checkTime();
  const checkpoint = decodeBoaCheckpoint(readVerifiedPayload(verified));
  if (
    checkpoint.tableLength !== data.tableLength ||
    checkpoint.memory.length < data.initialPages * PAGE_BYTES ||
    checkpoint.memory.length > data.maximumPages * PAGE_BYTES
  )
    fail('CHECKPOINT_STATE');
  checkTime();
  const instance = createBoaInstance(runtime);
  const initialStack = instanceData(instance).initialStack;
  if (checkpoint.globals[0]!.value !== initialStack) fail('CHECKPOINT_STATE');
  const missingPages = (checkpoint.memory.length - instance.memory.buffer.byteLength) / PAGE_BYTES;
  if (missingPages) instance.memory.grow(missingPages);
  new Uint8Array(instance.memory.buffer).set(checkpoint.memory);
  instance.__stack_pointer.value = checkpoint.globals[0]!.value;
  if (
    instance.root_pointer() !== checkpoint.rootPointer ||
    instance.compile_calls() !== 1 ||
    instance.execute_calls() !== 0 ||
    instance.source_retention_disabled() !== 1
  )
    fail('CHECKPOINT_STATE');
  let remaining = fuel(instance, true);
  if (instance.export_names_json() !== 1) checkFailure(instance);
  const names = array(readBoaResult(instance), 256);
  if (
    names.some((name) => typeof name !== 'string' || name.length > 8192) ||
    new Set(names).size !== names.length ||
    !names.includes('main') ||
    instance.execute_calls() !== 0 ||
    instance.compile_calls() !== 1 ||
    instance.__stack_pointer.value !== initialStack ||
    fuel(instance, true) !== remaining
  )
    fail('CHECKPOINT_STATE');
  const exportNames = Object.freeze(names as string[]);
  checkTime();
  let invoked = false;
  return Object.freeze({
    exportNames,
    get remainingInstructions() {
      return remaining;
    },
    invoke(args: readonly BoaArgument[] = []): BoaValue {
      if (invoked) fail('ALREADY_INVOKED');
      invoked = true;
      checkTime();
      const input = argumentsJson(args);
      checkTime();
      let pointer = 0;
      let status = 0;
      try {
        pointer = instance.alloc_input(input.length);
        integer(pointer, 1, instance.memory.buffer.byteLength - input.length, 'RUNTIME_ABI');
        new Uint8Array(instance.memory.buffer, pointer, input.length).set(input);
        checkTime();
        status = instance.invoke_json_args(pointer, input.length);
      } catch (error) {
        checkTime();
        if (error instanceof BoaCheckpointError) throw error;
        return fail('EXECUTION_FAILED');
      } finally {
        if (pointer > 0 && pointer + input.length <= instance.memory.buffer.byteLength)
          new Uint8Array(instance.memory.buffer, pointer, input.length).fill(0);
        input.fill(0);
      }
      checkTime();
      const after = fuel(instance, false);
      if (
        after > remaining ||
        instance.compile_calls() !== 1 ||
        instance.execute_calls() !== 1 ||
        instance.__stack_pointer.value !== initialStack
      )
        fail('CHECKPOINT_STATE');
      remaining = after;
      if (status !== 1) checkFailure(instance);
      return primitive(readBoaResult(instance));
    },
  });
}
