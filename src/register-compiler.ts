import { createHash } from 'node:crypto';
import { SeededRandom } from './random.js';
import { compileModule as compileIR, CompileError, type CompileOptions } from './frontend.js';
import { OPS as IR_OPS, type FunctionCode as IRFunction, type Op as IROp } from './ir.js';
import {
  DIALECT_FORMAT,
  FORMAT,
  LIMITS,
  OPS,
  type Artifact,
  type Dialect,
  type FunctionCode,
  type Instruction,
  type Op,
} from './register-contract.js';

export { CompileError } from './frontend.js';
export type { CompileOptions } from './frontend.js';
export interface Compilation {
  artifact: Artifact;
  dialect: Dialect;
}

function profile(epoch: number, variant: string): Dialect {
  const random = new SeededRandom(`jovault-register-dialect-0:${epoch}:${variant}`);
  const values = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const limit = 256 - (256 % (i + 1));
    let index: number;
    do index = random.byte();
    while (index >= limit);
    index %= i + 1;
    [values[i], values[index]] = [values[index]!, values[i]!];
  }
  const opcodes = values.slice(0, OPS.length);
  const id = createHash('sha256')
    .update(JSON.stringify([DIALECT_FORMAT, epoch, variant, opcodes]))
    .digest('hex');
  return { format: DIALECT_FORMAT, id, epoch, opcodes };
}

const BINARY = new Set<IROp>([
  'add',
  'subtract',
  'multiply',
  'divide',
  'remainder',
  'power',
  'bit_and',
  'bit_or',
  'bit_xor',
  'shift_left',
  'shift_right',
  'shift_unsigned',
  'equal',
  'not_equal',
  'less',
  'less_equal',
  'greater',
  'greater_equal',
]);
const UNARY = new Set<IROp>(['negate', 'positive', 'not', 'bit_not']);

/** The stack-shaped frontend IR never ships. CFG joins fix temporary register positions. */
function lower(
  fn: IRFunction,
  irDialect: { readonly opcodes: readonly number[] },
  dialect: Dialect,
): FunctionCode {
  const meanings = new Map(irDialect.opcodes.map((byte, index) => [byte, IR_OPS[index]!]));
  const heights = new Map<number, number>([[0, 0]]);
  const work = [0];
  let maxHeight = 0;
  while (work.length) {
    const pc = work.pop()!;
    const depth = heights.get(pc)!;
    const [byte, operand, count] = fn.code[pc]!;
    const op = meanings.get(byte)!;
    const consumed = BINARY.has(op)
      ? 2
      : UNARY.has(op) || ['pop', 'store', 'dup', 'jump_false', 'jump_true', 'return'].includes(op)
        ? 1
        : op === 'call' || op === 'host_call'
          ? count
          : 0;
    const produced =
      ['constant', 'undefined', 'load', 'call', 'host_call'].includes(op) ||
      BINARY.has(op) ||
      UNARY.has(op)
        ? 1
        : op === 'dup'
          ? 2
          : 0;
    if (depth < consumed)
      throw new CompileError('IR_STACK', 1, 1, 'invalid compiler intermediate state');
    const next = depth - consumed + produced;
    maxHeight = Math.max(maxHeight, depth, next);
    if (maxHeight > LIMITS.stack)
      throw new CompileError('REGISTER_LIMIT', 1, 1, 'expression register limit exceeded');
    const successors =
      op === 'return'
        ? []
        : op === 'jump'
          ? [operand]
          : op === 'jump_false' || op === 'jump_true'
            ? [pc + 1, operand]
            : [pc + 1];
    for (const target of successors) {
      if (target < 0 || target >= fn.code.length)
        throw new CompileError('IR_TARGET', 1, 1, 'invalid compiler branch');
      const known = heights.get(target);
      if (known !== undefined && known !== next)
        throw new CompileError('IR_JOIN', 1, 1, 'inconsistent compiler branch state');
      if (known === undefined) {
        heights.set(target, next);
        work.push(target);
      }
    }
  }
  const registers = Math.max(1, fn.locals + maxHeight);
  if (registers > LIMITS.registers)
    throw new CompileError('REGISTER_LIMIT', 1, 1, 'too many registers');
  const encode = (op: Op, dst = 0, a = 0, b = 0, c = 0): Instruction => [
    dialect.opcodes[OPS.indexOf(op)]!,
    dst,
    a,
    b,
    c,
  ];
  const code = fn.code.map(([byte, operand, count], pc): Instruction => {
    const depth = heights.get(pc);
    // Keep instruction indices stable; dead instructions carry no source constants or effects.
    if (depth === undefined) return encode('nop');
    const op = meanings.get(byte)!;
    const top = fn.locals + depth;
    if (op === 'constant') return encode('constant', top, operand);
    if (op === 'undefined') return encode('undefined', top);
    if (op === 'load') return encode('move', top, operand);
    if (op === 'store') return encode('move', operand, top - 1);
    if (op === 'dup') return encode('move', top, top - 1);
    if (op === 'pop') return encode('nop');
    if (BINARY.has(op)) return encode(op as Op, top - 2, top - 2, top - 1);
    if (UNARY.has(op)) return encode(op as Op, top - 1, top - 1);
    if (op === 'jump') return encode('jump', 0, operand);
    if (op === 'jump_false' || op === 'jump_true') return encode(op, 0, top - 1, operand);
    if (op === 'call' || op === 'host_call')
      return encode(op, top - count, operand, top - count, count);
    if (op === 'return') return encode('return', 0, top - 1);
    throw new CompileError('IR_OPCODE', 1, 1, 'unsupported intermediate opcode');
  });
  return { parameters: fn.parameters, registers, code };
}

export function compileModule(source: string, options: CompileOptions = {}): Compilation {
  const ir = compileIR(source, options);
  const dialect = profile(ir.artifact.epoch, options.variant ?? 'default');
  const artifact: Artifact = {
    ...ir.artifact,
    format: FORMAT,
    dialect: dialect.id,
    functions: ir.artifact.functions.map((fn) => lower(fn, ir.dialect, dialect)),
  };
  return { artifact, dialect };
}

export function emitModule(
  { artifact, dialect }: Compilation,
  runtimeSpecifier = './jovault-runtime.mjs',
): string {
  if (!runtimeSpecifier || runtimeSpecifier.includes('\0')) throw new Error('RUNTIME_SPECIFIER');
  const lines = [
    `import { instantiate as __jovault_instantiate } from ${JSON.stringify(runtimeSpecifier)};`,
  ];
  artifact.imports.forEach((binding, i) => {
    const name = `__jovault_host_${i}`;
    lines.push(
      binding.imported === 'default'
        ? `import ${name} from ${JSON.stringify(binding.source)};`
        : `import { ${binding.imported} as ${name} } from ${JSON.stringify(binding.source)};`,
    );
  });
  const hosts = artifact.imports.map((_, i) => `(...args) => __jovault_host_${i}(...args)`);
  lines.push(
    `const __jovault_vm = __jovault_instantiate(${JSON.stringify(artifact)}, ${JSON.stringify(dialect)}, [${hosts.join(',')}]);`,
  );
  const wrappers = new Map<number, string>();
  for (const binding of artifact.exports) {
    let wrapper = wrappers.get(binding.function);
    if (!wrapper) {
      wrapper = `__jovault_export_${binding.function}`;
      wrappers.set(binding.function, wrapper);
      const count = artifact.functions[binding.function]!.parameters;
      const parameters = Array.from({ length: count }, (_, i) => `p${i}`).join(', ');
      lines.push(
        `function ${wrapper}(${parameters}) { return __jovault_vm.invoke(${JSON.stringify(binding.name)}, Array.from(arguments)); }`,
      );
    }
    lines.push(`export { ${wrapper} as ${binding.name} };`);
  }
  return lines.join('\n') + '\n';
}
