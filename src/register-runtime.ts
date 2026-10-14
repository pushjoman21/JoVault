import {
  DIALECT_FORMAT,
  EPOCH_MS,
  FORMAT,
  LIMITS,
  OPS,
  VaultError,
  type Artifact,
  type Constant,
  type Dialect,
  type HostFunction,
  type Instruction,
  type Op,
  type RuntimeOptions,
  type Value,
  type VaultInstance,
} from './register-contract.js';

function fail(code: string): never {
  throw new VaultError(code);
}

function integer(value: unknown, min: number, max: number, error: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(error);
  }
  return value as number;
}

function string(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.stringLength) {
    fail(error);
  }
  return value as string;
}

// Read data descriptors once. Accessors, inherited fields, and hidden extra fields are not wire data.
function record(value: unknown, keys: readonly string[], error: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(error);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(error);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(String(key))))
    fail(error);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property) || !property.enumerable) fail(error);
    result[key] = property.value as unknown;
  }
  return result;
}

function array(value: unknown, max: number, error: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(error);
  const input = value as unknown[];
  const length = integer(input.length, 0, max, error);
  if (Reflect.ownKeys(input).length !== length + 1) fail(error);
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const property = Object.getOwnPropertyDescriptor(input, String(index));
    if (!property || !('value' in property) || !property.enumerable) fail(error);
    copy.push(property.value as unknown);
  }
  return copy;
}

function value(input: unknown): Value {
  if (
    input === undefined ||
    input === null ||
    typeof input === 'boolean' ||
    typeof input === 'number' ||
    (typeof input === 'string' && input.length <= LIMITS.stringLength)
  ) {
    return input;
  }
  return fail('INVALID_VALUE');
}

function dialectSnapshot(input: unknown): Dialect {
  const error = 'INVALID_DIALECT';
  const data = record(input, ['format', 'id', 'epoch', 'opcodes'], error);
  if (data.format !== DIALECT_FORMAT) fail(error);
  const opcodes = array(data.opcodes, OPS.length, error).map((item) =>
    integer(item, 0, 255, error),
  );
  if (opcodes.length !== OPS.length || new Set(opcodes).size !== OPS.length) fail(error);
  Object.freeze(opcodes);
  return Object.freeze({
    format: DIALECT_FORMAT,
    id: string(data.id, error),
    epoch: integer(
      data.epoch,
      0,
      Math.floor((Number.MAX_SAFE_INTEGER - EPOCH_MS) / EPOCH_MS),
      error,
    ),
    opcodes,
  });
}

function artifactSnapshot(input: unknown, dialect: Dialect): Artifact {
  const error = 'INVALID_ARTIFACT';
  const data = record(
    input,
    [
      'format',
      'dialect',
      'epoch',
      'notBefore',
      'expiresAt',
      'constants',
      'imports',
      'functions',
      'exports',
    ],
    error,
  );
  if (data.format !== FORMAT) fail(error);
  const id = string(data.dialect, error);
  const epoch = integer(
    data.epoch,
    0,
    Math.floor((Number.MAX_SAFE_INTEGER - EPOCH_MS) / EPOCH_MS),
    error,
  );
  const notBefore = integer(data.notBefore, 0, Number.MAX_SAFE_INTEGER, error);
  const expiresAt = integer(data.expiresAt, 0, Number.MAX_SAFE_INTEGER, error);
  if (notBefore !== epoch * EPOCH_MS || expiresAt !== notBefore + EPOCH_MS) fail(error);
  if (id !== dialect.id || epoch !== dialect.epoch) fail('DIALECT_MISMATCH');
  const constants = array(data.constants, LIMITS.constants, error).map((item): Constant => {
    if (
      item === null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item)) ||
      (typeof item === 'string' && item.length <= LIMITS.stringLength)
    ) {
      return item;
    }
    return fail(error);
  });
  const imports = array(data.imports, LIMITS.imports, error).map((item) => {
    const entry = record(item, ['source', 'imported'], error);
    return Object.freeze({
      source: string(entry.source, error),
      imported: string(entry.imported, error),
    });
  });
  let instructions = 0;
  const functions = array(data.functions, LIMITS.functions, error).map((item) => {
    const entry = record(item, ['parameters', 'registers', 'code'], error);
    const parameters = integer(entry.parameters, 0, LIMITS.parameters, error);
    const registers = integer(entry.registers, Math.max(1, parameters), LIMITS.registers, error);
    const code = array(entry.code, LIMITS.instructions - instructions, error).map(
      (raw): Instruction => {
        const tuple = array(raw, 5, error);
        if (tuple.length !== 5) fail(error);
        return [
          integer(tuple[0], 0, 255, error),
          integer(tuple[1], 0, LIMITS.instructions, error),
          integer(tuple[2], 0, LIMITS.instructions, error),
          integer(tuple[3], 0, LIMITS.instructions, error),
          integer(tuple[4], 0, LIMITS.parameters, error),
        ];
      },
    );
    if (code.length === 0) fail(error);
    instructions += code.length;
    return { parameters, registers, code };
  });
  if (functions.length === 0) fail(error);
  for (const fn of functions) {
    for (const tuple of fn.code) {
      const op = OPS[dialect.opcodes.indexOf(tuple[0])];
      const [, dst, a, b, c] = tuple;
      if (op === undefined) fail(error);
      const reg = (index: number): void => {
        if (index >= fn.registers) fail(error);
      };
      const zero = (...indices: number[]): void => {
        if (indices.some((index) => index !== 0)) fail(error);
      };
      switch (op) {
        case 'constant':
          reg(dst);
          if (a >= constants.length) fail(error);
          zero(b, c);
          break;
        case 'undefined':
          reg(dst);
          zero(a, b, c);
          break;
        case 'nop':
          zero(dst, a, b, c);
          break;
        case 'move':
        case 'negate':
        case 'positive':
        case 'not':
        case 'bit_not':
          reg(dst);
          reg(a);
          zero(b, c);
          break;
        case 'jump':
          zero(dst, b, c);
          if (a >= fn.code.length) fail(error);
          break;
        case 'jump_false':
        case 'jump_true':
          zero(dst, c);
          reg(a);
          if (b >= fn.code.length) fail(error);
          break;
        case 'call':
        case 'host_call':
          reg(dst);
          if (a >= (op === 'call' ? functions.length : imports.length)) fail(error);
          if (b > fn.registers || b + c > fn.registers) fail(error);
          break;
        case 'return':
          zero(dst, b, c);
          reg(a);
          break;
        default:
          reg(dst);
          reg(a);
          reg(b);
          zero(c);
      }
      Object.freeze(tuple);
    }
    Object.freeze(fn.code);
    Object.freeze(fn);
  }
  const names = new Set<string>();
  const exports = array(data.exports, LIMITS.exports, error).map((item) => {
    const entry = record(item, ['name', 'function'], error);
    const name = string(entry.name, error);
    if (names.has(name)) fail(error);
    names.add(name);
    return Object.freeze({
      name,
      function: integer(entry.function, 0, functions.length - 1, error),
    });
  });
  Object.freeze(constants);
  Object.freeze(imports);
  Object.freeze(functions);
  Object.freeze(exports);
  return Object.freeze({
    format: FORMAT,
    dialect: id,
    epoch,
    notBefore,
    expiresAt,
    constants,
    imports,
    functions,
    exports,
  });
}

function binary(op: Op, left: Value, right: Value): Value {
  switch (op) {
    case 'add':
      return typeof left === 'string' || typeof right === 'string'
        ? String(left) + String(right)
        : Number(left) + Number(right);
    case 'subtract':
      return Number(left) - Number(right);
    case 'multiply':
      return Number(left) * Number(right);
    case 'divide':
      return Number(left) / Number(right);
    case 'remainder':
      return Number(left) % Number(right);
    case 'power':
      return Number(left) ** Number(right);
    case 'bit_and':
      return Number(left) & Number(right);
    case 'bit_or':
      return Number(left) | Number(right);
    case 'bit_xor':
      return Number(left) ^ Number(right);
    case 'shift_left':
      return Number(left) << Number(right);
    case 'shift_right':
      return Number(left) >> Number(right);
    case 'shift_unsigned':
      return Number(left) >>> Number(right);
    case 'equal':
      return left === right;
    case 'not_equal':
      return left !== right;
    case 'less':
      return typeof left === 'string' && typeof right === 'string'
        ? left < right
        : Number(left) < Number(right);
    case 'less_equal':
      return typeof left === 'string' && typeof right === 'string'
        ? left <= right
        : Number(left) <= Number(right);
    case 'greater':
      return typeof left === 'string' && typeof right === 'string'
        ? left > right
        : Number(left) > Number(right);
    case 'greater_equal':
      return typeof left === 'string' && typeof right === 'string'
        ? left >= right
        : Number(left) >= Number(right);
    default:
      return fail('INVALID_ARTIFACT');
  }
}

interface Frame {
  functionIndex: number;
  pc: number;
  registers: Value[];
  returnDestination: number;
}

/** Executes only the declared primitive instruction language and explicit host capabilities. */
export function instantiate(
  artifact: unknown,
  dialect: unknown,
  hosts: readonly HostFunction[] = [],
  options: RuntimeOptions = {},
): VaultInstance {
  let profile: Dialect;
  let program: Artifact;
  let capabilities: HostFunction[];
  let now: () => number;
  let maxSteps: number;
  try {
    profile = dialectSnapshot(dialect);
    program = artifactSnapshot(artifact, profile);
    const supplied = array(hosts, LIMITS.imports, 'INVALID_HOSTS');
    if (
      supplied.length !== program.imports.length ||
      supplied.some((host) => typeof host !== 'function')
    )
      fail('INVALID_HOSTS');
    capabilities = supplied as HostFunction[];
    Object.freeze(capabilities);
    // Options are optional fields, but their names and descriptors are still checked.
    if (typeof options !== 'object' || options === null) fail('INVALID_OPTIONS');
    const keys = Reflect.ownKeys(options);
    if (keys.some((key) => key !== 'now' && key !== 'maxSteps')) fail('INVALID_OPTIONS');
    const settings = record(options, keys as string[], 'INVALID_OPTIONS');
    if ('now' in settings && typeof settings.now !== 'function') fail('INVALID_OPTIONS');
    now = (settings.now as (() => number) | undefined) ?? Date.now;
    maxSteps =
      'maxSteps' in settings
        ? integer(settings.maxSteps, 1, LIMITS.steps, 'INVALID_OPTIONS')
        : LIMITS.steps;
  } catch (error) {
    if (error instanceof VaultError) throw error;
    return fail('INVALID_ARTIFACT');
  }
  const decoding = new Map<number, Op>();
  profile.opcodes.forEach((opcode, index) => {
    decoding.set(opcode, OPS[index]!);
  });
  const exports = new Map(program.exports.map((entry) => [entry.name, entry.function]));
  let active = false;
  function checkTime(): void {
    let instant: unknown;
    try {
      instant = now();
    } catch {
      fail('INVALID_CLOCK');
    }
    if (typeof instant !== 'number' || !Number.isFinite(instant) || instant < 0)
      fail('INVALID_CLOCK');
    if (instant < program.notBefore) fail('NOT_YET_VALID');
    if (instant >= program.expiresAt) fail('EXPIRED');
  }
  function frame(functionIndex: number, args: Value[], returnDestination = 0): Frame {
    const fn = program.functions[functionIndex]!;
    const registers = new Array<Value>(fn.registers).fill(undefined);
    for (let index = 0; index < fn.parameters && index < args.length; index++)
      registers[index] = args[index];
    return { functionIndex, pc: 0, registers, returnDestination };
  }
  checkTime();
  return Object.freeze({
    invoke(exportName: string, args: readonly Value[]): Value {
      if (active) fail('REENTRANCY');
      active = true;
      try {
        checkTime();
        if (typeof exportName !== 'string') fail('INVALID_EXPORT');
        const index = exports.get(exportName);
        if (index === undefined) fail('INVALID_EXPORT');
        let inputs: Value[];
        try {
          inputs = array(args, LIMITS.parameters, 'INVALID_VALUE').map(value);
        } catch (error) {
          if (error instanceof VaultError) throw error;
          return fail('INVALID_VALUE');
        }
        const frames = [frame(index, inputs)];
        let steps = 0;
        while (frames.length > 0) {
          checkTime();
          if (++steps > maxSteps) fail('STEP_LIMIT');
          const current = frames[frames.length - 1]!;
          const tuple = program.functions[current.functionIndex]!.code[current.pc++];
          if (!tuple) fail('INVALID_ARTIFACT');
          const op = decoding.get(tuple[0])!;
          const [, dst, a, b, c] = tuple;
          const registers = current.registers;
          switch (op) {
            case 'constant':
              registers[dst] = program.constants[a];
              break;
            case 'undefined':
              registers[dst] = undefined;
              break;
            case 'move':
              registers[dst] = registers[a];
              break;
            case 'nop':
              break;
            case 'negate':
              registers[dst] = -Number(registers[a]);
              break;
            case 'positive':
              registers[dst] = Number(registers[a]);
              break;
            case 'not':
              registers[dst] = !registers[a];
              break;
            case 'bit_not':
              registers[dst] = ~Number(registers[a]);
              break;
            case 'jump':
              current.pc = a;
              break;
            case 'jump_false':
              if (!registers[a]) current.pc = b;
              break;
            case 'jump_true':
              if (registers[a]) current.pc = b;
              break;
            case 'call':
            case 'host_call': {
              const callArgs = registers.slice(b, b + c);
              if (op === 'call') {
                if (frames.length >= LIMITS.callDepth) fail('CALL_DEPTH');
                frames.push(frame(a, callArgs, dst));
              } else {
                let result: unknown;
                const host = capabilities[a]!;
                try {
                  result = host(...callArgs);
                } catch {
                  fail('HOST_FAILURE');
                }
                // A host may advance the clock; reject before returning or using its result.
                checkTime();
                registers[dst] = value(result);
              }
              break;
            }
            case 'return': {
              const result = registers[a];
              frames.pop();
              if (frames.length === 0) return result;
              frames[frames.length - 1]!.registers[current.returnDestination] = result;
              break;
            }
            default: {
              registers[dst] = value(binary(op, registers[a], registers[b]));
            }
          }
        }
        return fail('INVALID_ARTIFACT');
      } finally {
        active = false;
      }
    },
  });
}
