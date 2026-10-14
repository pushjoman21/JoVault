import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import ts from 'typescript';
import { SeededRandom } from './random.js';
import {
  DIALECT_FORMAT,
  EPOCH_MS,
  FORMAT,
  LIMITS,
  OPS,
  type Artifact,
  type Constant,
  type Dialect,
  type FunctionCode,
  type Instruction,
  type Op,
} from './ir.js';

export interface CompileOptions {
  now?: number;
  variant?: string;
  filename?: string;
}

export interface Compilation {
  artifact: Artifact;
  dialect: Dialect;
}

export class CompileError extends Error {
  constructor(
    public readonly code: string,
    public readonly line: number,
    public readonly column: number,
    detail: string,
  ) {
    super(`${code} at ${line}:${column}: ${detail}`);
    this.name = 'CompileError';
  }
}

type Local = { slot: number; mutable: boolean; initialized: boolean };
type Callable = { kind: 'call' | 'host_call'; index: number };

const INVALID_BINDINGS = new Set([
  'eval',
  'arguments',
  'await',
  'yield',
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
]);

const BINARY = new Map<ts.SyntaxKind, Op>([
  [ts.SyntaxKind.PlusToken, 'add'],
  [ts.SyntaxKind.MinusToken, 'subtract'],
  [ts.SyntaxKind.AsteriskToken, 'multiply'],
  [ts.SyntaxKind.SlashToken, 'divide'],
  [ts.SyntaxKind.PercentToken, 'remainder'],
  [ts.SyntaxKind.AsteriskAsteriskToken, 'power'],
  [ts.SyntaxKind.AmpersandToken, 'bit_and'],
  [ts.SyntaxKind.BarToken, 'bit_or'],
  [ts.SyntaxKind.CaretToken, 'bit_xor'],
  [ts.SyntaxKind.LessThanLessThanToken, 'shift_left'],
  [ts.SyntaxKind.GreaterThanGreaterThanToken, 'shift_right'],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, 'shift_unsigned'],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, 'equal'],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, 'not_equal'],
  [ts.SyntaxKind.LessThanToken, 'less'],
  [ts.SyntaxKind.LessThanEqualsToken, 'less_equal'],
  [ts.SyntaxKind.GreaterThanToken, 'greater'],
  [ts.SyntaxKind.GreaterThanEqualsToken, 'greater_equal'],
]);

const COMPOUND = new Map<ts.SyntaxKind, Op>([
  [ts.SyntaxKind.PlusEqualsToken, 'add'],
  [ts.SyntaxKind.MinusEqualsToken, 'subtract'],
  [ts.SyntaxKind.AsteriskEqualsToken, 'multiply'],
  [ts.SyntaxKind.SlashEqualsToken, 'divide'],
  [ts.SyntaxKind.PercentEqualsToken, 'remainder'],
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken, 'power'],
  [ts.SyntaxKind.AmpersandEqualsToken, 'bit_and'],
  [ts.SyntaxKind.BarEqualsToken, 'bit_or'],
  [ts.SyntaxKind.CaretEqualsToken, 'bit_xor'],
  [ts.SyntaxKind.LessThanLessThanEqualsToken, 'shift_left'],
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, 'shift_right'],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, 'shift_unsigned'],
]);

function createDialect(epoch: number, variant: string): Dialect {
  // Reuse the existing deterministic fixture/variant generator, never for secrets.
  const random = new SeededRandom(`jovault-dialect-0:${epoch}:${variant}`);
  const mapping = Array.from({ length: 256 }, (_, i) => i);
  const bounded = (n: number): number => {
    const limit = 256 - (256 % n);
    let byte: number;
    do byte = random.byte();
    while (byte >= limit);
    return byte % n;
  };
  for (let i = mapping.length - 1; i > 0; i--) {
    const other = bounded(i + 1);
    [mapping[i], mapping[other]] = [mapping[other]!, mapping[i]!];
  }
  const opcodes = mapping.slice(0, OPS.length);
  const id = createHash('sha256')
    .update(JSON.stringify([DIALECT_FORMAT, epoch, variant, opcodes]))
    .digest('hex');
  return { format: DIALECT_FORMAT, id, epoch, opcodes };
}

type ReportError = (node: ts.Node, code: string, detail: string) => never;

class FunctionCompiler {
  private readonly code: Instruction[] = [];
  private readonly scopes: Map<string, Local>[] = [new Map()];
  private localCount = 0;

  constructor(
    private readonly declaration: ts.FunctionDeclaration,
    private readonly dialect: Dialect,
    private readonly callables: ReadonlyMap<string, Callable>,
    private readonly instructionBudget: { used: number },
    private readonly fail: ReportError,
    private readonly checkBinding: (name: string, node: ts.Node) => void,
    private readonly addConstant: (value: Constant, node: ts.Node) => number,
  ) {}

  compile(): FunctionCode {
    const declaration = this.declaration;
    if (
      !declaration.body ||
      declaration.asteriskToken ||
      declaration.type ||
      declaration.typeParameters ||
      declaration.modifiers?.some(
        (m) => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.DefaultKeyword,
      )
    )
      this.fail(
        declaration,
        'UNSUPPORTED_FUNCTION',
        'only synchronous untyped functions are supported',
      );
    if (declaration.parameters.length > LIMITS.parameters)
      this.fail(declaration, 'PARAMETER_LIMIT', 'too many parameters');

    for (const parameter of declaration.parameters) {
      if (
        !ts.isIdentifier(parameter.name) ||
        parameter.initializer ||
        parameter.dotDotDotToken ||
        parameter.questionToken ||
        parameter.type ||
        parameter.modifiers
      )
        this.fail(parameter, 'UNSUPPORTED_PARAMETER', 'parameters must be simple identifiers');
      this.allocateLocal(parameter.name.text, true, true, parameter);
    }

    this.compileStatements(declaration.body.statements, false);
    this.emit('undefined');
    this.emit('return');
    return {
      parameters: declaration.parameters.length,
      locals: this.localCount,
      code: this.code,
    };
  }

  private allocateLocal(
    name: string,
    mutable: boolean,
    initialized: boolean,
    node: ts.Node,
  ): Local {
    this.checkBinding(name, node);
    const scope = this.scopes.at(-1)!;
    if (scope.has(name)) this.fail(node, 'DUPLICATE_BINDING', 'duplicate local binding');
    if (this.localCount >= LIMITS.locals) this.fail(node, 'LOCAL_LIMIT', 'too many locals');
    const binding = { slot: this.localCount++, mutable, initialized };
    scope.set(name, binding);
    return binding;
  }

  private emit(op: Op, operand = 0, count = 0): number {
    if (++this.instructionBudget.used > LIMITS.instructions)
      this.fail(this.declaration, 'INSTRUCTION_LIMIT', 'compiled instruction limit exceeded');
    this.code.push([this.dialect.opcodes[OPS.indexOf(op)]!, operand, count]);
    return this.code.length - 1;
  }

  private patchJump(index: number): void {
    this.code[index]![1] = this.code.length;
  }

  private resolveLocal(name: string): Local | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const binding = this.scopes[i]!.get(name);
      if (binding) return binding;
    }
    return undefined;
  }

  private requireLocal(name: ts.Identifier, write = false): Local {
    const binding = this.resolveLocal(name.text);
    if (!binding) this.fail(name, 'UNKNOWN_BINDING', 'unknown local binding');
    if (!binding.initialized)
      this.fail(name, 'TEMPORAL_DEAD_ZONE', 'binding used before initialization');
    if (write && !binding.mutable)
      this.fail(name, 'CONST_ASSIGNMENT', 'cannot assign a const binding');
    return binding;
  }

  private compileExpression(node: ts.Expression): void {
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      if (!Number.isFinite(value))
        this.fail(node, 'CONSTANT_LIMIT', 'number literal must be finite');
      this.emit('constant', this.addConstant(value, node));
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      this.emit('constant', this.addConstant(node.text, node));
    } else if (
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword
    ) {
      this.emit('constant', this.addConstant(node.kind === ts.SyntaxKind.TrueKeyword, node));
    } else if (node.kind === ts.SyntaxKind.NullKeyword) {
      this.emit('constant', this.addConstant(null, node));
    } else if (ts.isIdentifier(node)) {
      if (this.resolveLocal(node.text)) this.emit('load', this.requireLocal(node).slot);
      else if (this.callables.has(node.text))
        this.fail(node, 'UNSUPPORTED_EXPRESSION', 'function bindings can only be called directly');
      else if (node.text === 'undefined') this.emit('undefined');
      else if (node.text === 'NaN' || node.text === 'Infinity') {
        this.emit('constant', this.addConstant(node.text === 'NaN' ? 0 : 1, node));
        this.emit('constant', this.addConstant(0, node));
        this.emit('divide');
      } else this.fail(node, 'UNKNOWN_BINDING', 'value is not a local primitive');
    } else if (ts.isParenthesizedExpression(node)) this.compileExpression(node.expression);
    else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      const compound = COMPOUND.get(operator);
      if (operator === ts.SyntaxKind.EqualsToken || compound) {
        if (!ts.isIdentifier(node.left))
          this.fail(node.left, 'UNSUPPORTED_ASSIGNMENT', 'local required');
        const binding = this.requireLocal(node.left, true);
        if (compound) this.emit('load', binding.slot);
        this.compileExpression(node.right);
        if (compound) this.emit(compound);
        this.emit('dup');
        this.emit('store', binding.slot);
      } else if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.BarBarToken
      ) {
        this.compileExpression(node.left);
        this.emit('dup');
        const branch = this.emit(
          operator === ts.SyntaxKind.AmpersandAmpersandToken ? 'jump_false' : 'jump_true',
        );
        this.emit('pop');
        this.compileExpression(node.right);
        this.patchJump(branch);
      } else {
        const operation = BINARY.get(operator);
        if (!operation)
          this.fail(node.operatorToken, 'UNSUPPORTED_OPERATOR', 'operator is not supported');
        this.compileExpression(node.left);
        this.compileExpression(node.right);
        this.emit(operation);
      }
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const operator = node.operator;
      if (operator === ts.SyntaxKind.PlusPlusToken || operator === ts.SyntaxKind.MinusMinusToken) {
        if (!ts.isIdentifier(node.operand))
          this.fail(node, 'UNSUPPORTED_ASSIGNMENT', 'local required');
        const binding = this.requireLocal(node.operand, true);
        this.emit('load', binding.slot);
        this.emit('positive');
        if (ts.isPostfixUnaryExpression(node)) this.emit('dup');
        this.emit('constant', this.addConstant(1, node));
        this.emit(operator === ts.SyntaxKind.PlusPlusToken ? 'add' : 'subtract');
        if (ts.isPrefixUnaryExpression(node)) this.emit('dup');
        this.emit('store', binding.slot);
      } else {
        const unary = new Map<ts.SyntaxKind, Op>([
          [ts.SyntaxKind.PlusToken, 'positive'],
          [ts.SyntaxKind.MinusToken, 'negate'],
          [ts.SyntaxKind.ExclamationToken, 'not'],
          [ts.SyntaxKind.TildeToken, 'bit_not'],
        ]).get(operator);
        if (!unary) this.fail(node, 'UNSUPPORTED_OPERATOR', 'unary operator is not supported');
        this.compileExpression(node.operand);
        this.emit(unary);
      }
    } else if (ts.isConditionalExpression(node)) {
      this.compileExpression(node.condition);
      const alternate = this.emit('jump_false');
      this.compileExpression(node.whenTrue);
      const end = this.emit('jump');
      this.patchJump(alternate);
      this.compileExpression(node.whenFalse);
      this.patchJump(end);
    } else if (ts.isCallExpression(node)) {
      if (!ts.isIdentifier(node.expression) || node.questionDotToken || node.typeArguments)
        this.fail(node, 'UNSUPPORTED_CALL', 'calls require a direct function binding');
      const target = this.callables.get(node.expression.text);
      if (!target || this.resolveLocal(node.expression.text))
        this.fail(
          node.expression,
          'UNSUPPORTED_CALL',
          'call target must be a module function or import',
        );
      if (node.arguments.length > LIMITS.parameters)
        this.fail(node, 'PARAMETER_LIMIT', 'too many call arguments');
      for (const argument of node.arguments) this.compileExpression(argument);
      this.emit(target.kind, target.index, node.arguments.length);
    } else this.fail(node, 'UNSUPPORTED_EXPRESSION', `unsupported ${ts.SyntaxKind[node.kind]}`);
  }

  private declareLocals(list: ts.VariableDeclarationList): void {
    const kind = list.flags & ts.NodeFlags.BlockScoped;
    if (kind !== ts.NodeFlags.Let && kind !== ts.NodeFlags.Const)
      this.fail(list, 'UNSUPPORTED_DECLARATION', 'use let or const');
    for (const item of list.declarations) {
      if (!ts.isIdentifier(item.name) || item.type || item.exclamationToken)
        this.fail(item, 'UNSUPPORTED_DECLARATION', 'declarations require a simple identifier');
      this.allocateLocal(item.name.text, !(list.flags & ts.NodeFlags.Const), false, item);
    }
  }

  private initializeLocals(list: ts.VariableDeclarationList): void {
    for (const item of list.declarations) {
      if (!ts.isIdentifier(item.name)) this.fail(item, 'UNSUPPORTED_DECLARATION', 'local required');
      const binding = this.resolveLocal(item.name.text)!;
      if (!item.initializer && !binding.mutable)
        this.fail(item, 'CONST_INITIALIZER', 'const requires an initializer');
      if (item.initializer) this.compileExpression(item.initializer);
      else this.emit('undefined');
      this.emit('store', binding.slot);
      binding.initialized = true;
    }
  }

  private compileStatements(items: readonly ts.Statement[], nested: boolean): void {
    if (nested) this.scopes.push(new Map());
    for (const item of items)
      if (ts.isVariableStatement(item)) this.declareLocals(item.declarationList);
    for (const item of items) this.compileStatement(item);
    if (nested) this.scopes.pop();
  }

  private compileStatement(node: ts.Statement): void {
    if (ts.isBlock(node)) this.compileStatements(node.statements, true);
    else if (ts.isReturnStatement(node)) {
      if (node.expression) this.compileExpression(node.expression);
      else this.emit('undefined');
      this.emit('return');
    } else if (ts.isVariableStatement(node)) {
      if (!ts.isBlock(node.parent))
        this.fail(node, 'SYNTAX', 'a lexical declaration requires a block');
      this.initializeLocals(node.declarationList);
    } else if (ts.isExpressionStatement(node)) {
      this.compileExpression(node.expression);
      this.emit('pop');
    } else if (ts.isIfStatement(node)) {
      this.compileExpression(node.expression);
      const alternate = this.emit('jump_false');
      this.compileStatement(node.thenStatement);
      if (node.elseStatement) {
        const end = this.emit('jump');
        this.patchJump(alternate);
        this.compileStatement(node.elseStatement);
        this.patchJump(end);
      } else this.patchJump(alternate);
    } else if (ts.isWhileStatement(node)) {
      const start = this.code.length;
      this.compileExpression(node.expression);
      const end = this.emit('jump_false');
      this.compileStatement(node.statement);
      this.emit('jump', start);
      this.patchJump(end);
    } else if (ts.isForStatement(node)) {
      this.scopes.push(new Map());
      if (node.initializer) {
        if (ts.isVariableDeclarationList(node.initializer)) {
          this.declareLocals(node.initializer);
          this.initializeLocals(node.initializer);
        } else {
          this.compileExpression(node.initializer);
          this.emit('pop');
        }
      }
      const start = this.code.length;
      if (node.condition) this.compileExpression(node.condition);
      else this.emit('constant', this.addConstant(true, node));
      const end = this.emit('jump_false');
      this.compileStatement(node.statement);
      if (node.incrementor) {
        this.compileExpression(node.incrementor);
        this.emit('pop');
      }
      this.emit('jump', start);
      this.patchJump(end);
      this.scopes.pop();
    } else if (!ts.isEmptyStatement(node))
      this.fail(node, 'UNSUPPORTED_STATEMENT', `unsupported ${ts.SyntaxKind[node.kind]}`);
  }
}

/** Compile only the documented JS subset; unsupported syntax never falls back to source. */
export function compileModule(source: string, options: CompileOptions = {}): Compilation {
  if (typeof source !== 'string' || Buffer.byteLength(source) > LIMITS.sourceBytes)
    throw new CompileError('SOURCE_LIMIT', 1, 1, 'source must fit the byte limit');
  const now = options.now ?? Date.now();
  const variant = options.variant ?? 'default';
  const filename = options.filename === undefined ? 'module.js' : options.filename;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - EPOCH_MS ||
    typeof variant !== 'string' ||
    variant.length > 128
  )
    throw new CompileError('OPTIONS', 1, 1, 'invalid build time or variant');
  if (
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename.length > LIMITS.stringLength ||
    /[\0\r\n]/.test(filename) ||
    !/\.(?:c|m)?js$/i.test(filename)
  )
    throw new CompileError('OPTIONS', 1, 1, 'filename must name a JavaScript source file');
  const sourceName = posix.normalize(filename.replaceAll('\\', '/'));
  const epoch = Math.floor(now / EPOCH_MS);
  const dialect = createDialect(epoch, variant);
  let file: ts.SourceFile;
  try {
    file = ts.createSourceFile(sourceName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  } catch {
    throw new CompileError('SYNTAX', 1, 1, 'parser rejected source');
  }
  const fail: ReportError = (node, code, detail) => {
    const pos = file.getLineAndCharacterOfPosition(node.getStart(file));
    throw new CompileError(code, pos.line + 1, pos.character + 1, detail);
  };
  // The parser sees one supplied source; imports never trigger filesystem reads.
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === sourceName ? file : undefined),
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: (name) => name === sourceName,
    readFile: (name) => (name === sourceName ? source : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram(
    [sourceName],
    { allowJs: true, noResolve: true, noLib: true, types: [] },
    host,
  );
  const diagnostic = program.getSyntacticDiagnostics(file)[0];
  if (diagnostic) {
    const pos = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new CompileError('SYNTAX', pos.line + 1, pos.character + 1, 'invalid JavaScript syntax');
  }
  const nodes: { node: ts.Node; depth: number }[] = [{ node: file, depth: 0 }];
  while (nodes.length) {
    const current = nodes.pop()!;
    if (current.depth > LIMITS.syntaxDepth)
      fail(current.node, 'SYNTAX_DEPTH', 'syntax nesting exceeds the limit');
    ts.forEachChild(current.node, (node) => {
      nodes.push({ node, depth: current.depth + 1 });
    });
  }
  const artifact: Artifact = {
    format: FORMAT,
    dialect: dialect.id,
    epoch,
    notBefore: epoch * EPOCH_MS,
    expiresAt: (epoch + 1) * EPOCH_MS,
    constants: [],
    imports: [],
    functions: [],
    exports: [],
  };
  const constants = new Map<string, number>();
  const callables = new Map<string, Callable>();
  const declarations: ts.FunctionDeclaration[] = [];
  const functionIndices = new Map<ts.FunctionDeclaration, number>();
  const exportNames = new Set<string>();
  const checkBinding = (name: string, node: ts.Node): void => {
    if (INVALID_BINDINGS.has(name) || name.length > LIMITS.stringLength)
      fail(node, 'INVALID_BINDING', 'binding is not valid in a strict ECMAScript module');
  };
  const addBinding = (name: string, value: Callable, node: ts.Node): void => {
    checkBinding(name, node);
    if (callables.has(name)) fail(node, 'DUPLICATE_BINDING', 'duplicate module binding');
    callables.set(name, value);
  };
  const addExport = (name: string, index: number, node: ts.Node): void => {
    if (exportNames.has(name)) fail(node, 'DUPLICATE_EXPORT', 'duplicate export name');
    if (exportNames.size >= LIMITS.exports) fail(node, 'EXPORT_LIMIT', 'too many exports');
    exportNames.add(name);
    artifact.exports.push({ name, function: index });
  };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (
        !clause ||
        clause.isTypeOnly ||
        statement.attributes ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        (clause.namedBindings && !ts.isNamedImports(clause.namedBindings))
      )
        fail(
          statement,
          'UNSUPPORTED_IMPORT',
          'only named and default function imports are supported',
        );
      const sourceName = statement.moduleSpecifier.text;
      if (!sourceName || sourceName.length > LIMITS.stringLength || sourceName.includes('\0'))
        fail(statement, 'UNSUPPORTED_IMPORT', 'invalid module specifier');
      const addImport = (local: string, imported: string, node: ts.Node): void => {
        if (artifact.imports.length >= LIMITS.imports)
          fail(node, 'IMPORT_LIMIT', 'too many imports');
        addBinding(local, { kind: 'host_call', index: artifact.imports.length }, node);
        artifact.imports.push({ source: sourceName, imported });
      };
      if (clause.name) addImport(clause.name.text, 'default', clause.name);
      if (
        !clause.name &&
        ts.isNamedImports(clause.namedBindings!) &&
        !clause.namedBindings!.elements.length
      )
        fail(statement, 'UNSUPPORTED_IMPORT', 'side-effect-only imports are not supported');
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements) {
          if (
            element.isTypeOnly ||
            (element.propertyName && !ts.isIdentifier(element.propertyName))
          )
            fail(element, 'UNSUPPORTED_IMPORT', 'import binding must be an identifier');
          addImport(element.name.text, (element.propertyName ?? element.name).text, element);
        }
    } else if (ts.isFunctionDeclaration(statement)) {
      if (declarations.length >= LIMITS.functions)
        fail(statement, 'FUNCTION_LIMIT', 'too many functions');
      const index = declarations.length;
      functionIndices.set(statement, index);
      declarations.push(statement);
      if (statement.name) addBinding(statement.name.text, { kind: 'call', index }, statement.name);
      else if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        fail(statement, 'UNSUPPORTED_FUNCTION', 'anonymous function must be a default export');
    } else if (!ts.isExportDeclaration(statement) && !ts.isEmptyStatement(statement)) {
      fail(statement, 'UNSUPPORTED_TOP_LEVEL', 'module top level supports imports and functions');
    }
  }
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      const index = functionIndices.get(statement)!;
      if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        addExport('default', index, statement);
      else if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
        addExport(statement.name!.text, index, statement);
    } else if (ts.isExportDeclaration(statement)) {
      if (
        statement.moduleSpecifier ||
        statement.isTypeOnly ||
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause)
      )
        fail(statement, 'UNSUPPORTED_EXPORT', 're-exports and namespace exports are not supported');
      for (const element of statement.exportClause.elements) {
        const local = element.propertyName ?? element.name;
        if (element.isTypeOnly || !ts.isIdentifier(local) || !ts.isIdentifier(element.name))
          fail(element, 'UNSUPPORTED_EXPORT', 'export names must be identifiers');
        const target = callables.get(local.text);
        if (!target || target.kind !== 'call')
          fail(element, 'UNSUPPORTED_EXPORT', 'only local functions can be exported');
        addExport(element.name.text, target.index, element);
      }
    }
  }

  const instructionBudget = { used: 0 };
  const constant = (value: Constant, node: ts.Node): number => {
    if (typeof value === 'string' && value.length > LIMITS.stringLength)
      fail(node, 'CONSTANT_LIMIT', 'string exceeds the limit');
    const key = `${typeof value}:${JSON.stringify(value)}`;
    const existing = constants.get(key);
    if (existing !== undefined) return existing;
    if (constants.size >= LIMITS.constants) fail(node, 'CONSTANT_LIMIT', 'too many constants');
    const index = artifact.constants.length;
    constants.set(key, index);
    artifact.constants.push(value);
    return index;
  };
  for (const declaration of declarations) {
    artifact.functions.push(
      new FunctionCompiler(
        declaration,
        dialect,
        callables,
        instructionBudget,
        fail,
        checkBinding,
        constant,
      ).compile(),
    );
  }
  if (declarations.length === 0) fail(file, 'EMPTY_MODULE', 'at least one function is required');
  return { artifact, dialect };
}

/** A normal ESM wrapper. Relative dependencies resolve from the output module. */
export function emitModule(
  compilation: Compilation,
  runtimeSpecifier = './jovault-runtime.mjs',
): string {
  if (!runtimeSpecifier || runtimeSpecifier.includes('\0')) throw new Error('RUNTIME_SPECIFIER');
  const { artifact, dialect } = compilation;
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
  const capabilities = artifact.imports.map((_, i) => `(...args) => __jovault_host_${i}(...args)`);
  lines.push(
    `const __jovault_vm = __jovault_instantiate(${JSON.stringify(artifact)}, ${JSON.stringify(dialect)}, [${capabilities.join(',')}]);`,
  );
  const wrappers = new Map<number, string>();
  artifact.exports.forEach((binding, i) => {
    let wrapper = wrappers.get(binding.function);
    if (wrapper) {
      lines.push(`export { ${wrapper} as ${binding.name} };`);
      return;
    }
    wrapper = `__jovault_export_${i}`;
    wrappers.set(binding.function, wrapper);
    const count = artifact.functions[binding.function]!.parameters;
    const parameters = Array.from({ length: count }, (_, j) => `p${j}`).join(', ');
    lines.push(
      `function ${wrapper}(${parameters}) { return __jovault_vm.invoke(${JSON.stringify(binding.name)}, Array.from(arguments)); }`,
      `export { ${wrapper} as ${binding.name} };`,
    );
  });
  return lines.join('\n') + '\n';
}
