import { LIMITS as IR_LIMITS } from './ir.js';

export { EPOCH_MS, VaultError } from './ir.js';
export type { Constant, HostFunction, RuntimeOptions, Value, VaultInstance } from './ir.js';
export const FORMAT = 'JOVLT-R0' as const;
export const DIALECT_FORMAT = 'JOVLT-RD0' as const;
export const LIMITS = Object.freeze({ ...IR_LIMITS, registers: 8192 });
export const OPS = [
  'constant',
  'undefined',
  'move',
  'nop',
  'add',
  'subtract',
  'multiply',
  'divide',
  'remainder',
  'power',
  'negate',
  'positive',
  'not',
  'bit_not',
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
  'jump',
  'jump_false',
  'jump_true',
  'call',
  'host_call',
  'return',
] as const;
export type Op = (typeof OPS)[number];

/** All operands are nonnegative integers. Unused operands must be zero.
 * constant: dst, poolIndex; move/unary: dst, src; binary: dst, left, right.
 * jump: 0, target; jump_false/true: 0, condition, target.
 * call/host_call: dst, target, firstArgumentRegister, argumentCount.
 * return: 0, sourceRegister. Undefined writes dst; nop has no operands.
 */
export type Instruction = [opcode: number, dst: number, a: number, b: number, c: number];

export interface FunctionCode {
  parameters: number;
  registers: number;
  code: Instruction[];
}

export interface Dialect {
  format: typeof DIALECT_FORMAT;
  id: string;
  epoch: number;
  opcodes: number[];
}

export interface Artifact {
  format: typeof FORMAT;
  dialect: string;
  epoch: number;
  notBefore: number;
  expiresAt: number;
  constants: import('./ir.js').Constant[];
  imports: { source: string; imported: string }[];
  functions: FunctionCode[];
  exports: { name: string; function: number }[];
}
