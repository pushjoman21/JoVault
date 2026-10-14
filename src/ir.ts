/** Internal frontend IR and shared primitive types. Not the shipped register format. */
export const FORMAT = 'JOVLT-0' as const;
export const DIALECT_FORMAT = 'JOVLT-D0' as const;
export const EPOCH_MS = 600_000;

export const OPS = [
  'constant',
  'undefined',
  'load',
  'store',
  'pop',
  'dup',
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
export type Constant = number | string | boolean | null;
export type Value = Constant | undefined;
export type Instruction = [opcode: number, operand: number, argumentCount: number];

export interface FunctionCode {
  parameters: number;
  locals: number;
  code: Instruction[];
}

export interface ImportBinding {
  source: string;
  imported: string;
}

export interface ExportBinding {
  name: string;
  function: number;
}

export interface Artifact {
  format: typeof FORMAT;
  dialect: string;
  epoch: number;
  notBefore: number;
  expiresAt: number;
  constants: Constant[];
  imports: ImportBinding[];
  functions: FunctionCode[];
  exports: ExportBinding[];
}

/** opcodes[i] encodes OPS[i]. Keep this profile paired with its artifact. */
export interface Dialect {
  format: typeof DIALECT_FORMAT;
  id: string;
  epoch: number;
  opcodes: number[];
}

export const LIMITS = Object.freeze({
  sourceBytes: 1_048_576,
  functions: 256,
  imports: 128,
  exports: 256,
  parameters: 64,
  locals: 4096,
  constants: 4096,
  stringLength: 8192,
  instructions: 100_000,
  stack: 4096,
  callDepth: 64,
  steps: 200_000,
  syntaxDepth: 64,
});

export type HostFunction = (...args: Value[]) => Value;

export interface RuntimeOptions {
  /** Cooperative time source, injectable for tests; never a client trust anchor. */
  now?: () => number;
  /** Can lower the default instruction allowance, never raise it. */
  maxSteps?: number;
}

export interface VaultInstance {
  invoke(exportName: string, args: readonly Value[]): Value;
}

export class VaultError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'VaultError';
  }
}
