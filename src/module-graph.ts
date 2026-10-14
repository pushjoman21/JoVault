import ts from 'typescript';

/** Compiler input only. This format is neither linked modules nor executable bytecode. */
export const MODULE_GRAPH_FORMAT = 'jovault-module-input-v1' as const;
export const MODULE_GRAPH_LIMITS = Object.freeze({
  modules: 128,
  sourceBytes: 1_048_576,
  totalSourceBytes: 8_388_608,
  dependencies: 4096,
  specifierLength: 2048,
  syntaxDepth: 256,
  pathSegments: 64,
});
export type ModuleGraphLimits = Readonly<{ [K in keyof typeof MODULE_GRAPH_LIMITS]: number }>;
export type ModuleGraphLimitOptions = Partial<{ [K in keyof ModuleGraphLimits]: number }>;

export interface HostModuleGrant {
  /** Name of an explicitly granted host module; never an ambient package lookup. */
  capability: string;
}

export interface ModuleGraphOptions {
  /** Root-relative POSIX path; returned identities always begin with '/'. */
  entry: string;
  hostModules?: ReadonlyMap<string, HostModuleGrant>;
  /** Limits may be lowered, never raised above the documented defaults. */
  limits?: ModuleGraphLimitOptions;
}

export type DependencyTarget =
  Readonly<{ kind: 'module'; id: string }> | Readonly<{ kind: 'host'; capability: string }>;

export interface ModuleDependency {
  readonly kind: 'import' | 'reexport' | 'dynamic-import';
  /** Decoded string value. Original spelling remains in source at [start, end). */
  readonly specifier: string;
  readonly target: DependencyTarget;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly attributesSource?: string;
  readonly dynamicOptionsSource?: string;
}

export interface ModuleInput {
  readonly id: string;
  readonly kind: 'javascript' | 'json';
  /** Exact supplied text, including BOM, line endings and comments. Never rewritten. */
  readonly source: string;
  readonly bytes: number;
  readonly dependencies: readonly ModuleDependency[];
}

export interface ModuleGraph {
  readonly format: typeof MODULE_GRAPH_FORMAT;
  readonly entry: string;
  /** Deterministic breadth-first discovery order, not module evaluation order. */
  readonly modules: readonly ModuleInput[];
  readonly totalSourceBytes: number;
  readonly dependencyCount: number;
}

export class ModuleGraphError extends Error {
  constructor(
    public readonly code: string,
    public readonly moduleId: string,
    detail: string,
    public readonly line = 1,
    public readonly column = 1,
  ) {
    super(`${code}: ${moduleId}:${line}:${column}: ${detail}`);
    this.name = 'ModuleGraphError';
  }
}

function fail(code: string, id: string, detail: string): never {
  throw new ModuleGraphError(code, id, detail);
}

function limitsFor(options: ModuleGraphLimitOptions | undefined): ModuleGraphLimits {
  const limits: { -readonly [K in keyof ModuleGraphLimits]: number } = { ...MODULE_GRAPH_LIMITS };
  if (options !== undefined) {
    for (const key of Object.keys(options)) {
      if (!Object.hasOwn(MODULE_GRAPH_LIMITS, key))
        fail('INVALID_LIMIT', '', 'unknown graph limit');
      const name = key as keyof ModuleGraphLimits;
      const value = options[name];
      if (!Number.isSafeInteger(value) || value! < 1 || value! > MODULE_GRAPH_LIMITS[name])
        fail('INVALID_LIMIT', '', `invalid ${name} limit`);
      limits[name] = value!;
    }
  }
  return limits;
}

function checkPathText(text: string, id: string, limits: ModuleGraphLimits): void {
  if (
    typeof text !== 'string' ||
    !text ||
    text.startsWith('//') ||
    text.length > limits.specifierLength ||
    /[\\:%?#\u0000-\u001f\u007f]/u.test(text)
  )
    fail('INVALID_SPECIFIER', id, 'expected a bounded POSIX project path without URL aliases');
}

function projectId(text: string, parent: string, limits: ModuleGraphLimits): string {
  checkPathText(text, parent, limits);
  const result = parent ? parent.slice(1).split('/').slice(0, -1) : [];
  for (const part of text.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!result.length)
        fail('OUTSIDE_PROJECT', parent, 'module escapes the virtual project root');
      result.pop();
    } else result.push(part);
  }
  if (!result.length || result.length > limits.pathSegments)
    fail('INVALID_SPECIFIER', parent, 'expected a file within the bounded project root');
  return '/' + result.join('/');
}

function hostGrants(options: ModuleGraphOptions, limits: ModuleGraphLimits): Map<string, string> {
  const grants = new Map<string, string>();
  if (!options.hostModules) return grants;
  if (options.hostModules.size > limits.dependencies)
    fail('HOST_LIMIT', '', 'too many host grants');
  for (const [specifier, grant] of options.hostModules) {
    if (
      typeof specifier !== 'string' ||
      !specifier ||
      specifier.length > limits.specifierLength ||
      /^(?:\.|\/)/u.test(specifier) ||
      /[\\%?#\u0000-\u0020\u007f]/u.test(specifier) ||
      (specifier.includes(':') && !/^node:[a-zA-Z0-9_/-]+$/u.test(specifier)) ||
      typeof grant?.capability !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u.test(grant.capability)
    )
      fail(
        'INVALID_HOST_GRANT',
        '',
        'host modules need an exact bare specifier and capability name',
      );
    grants.set(specifier, grant.capability);
  }
  return grants;
}

function targetFor(
  specifier: string,
  id: string,
  grants: ReadonlyMap<string, string>,
  limits: ModuleGraphLimits,
): DependencyTarget {
  const capability = grants.get(specifier);
  if (capability !== undefined) return Object.freeze({ kind: 'host', capability });
  checkPathText(specifier, id, limits);
  if (!specifier.startsWith('./') && !specifier.startsWith('../'))
    fail('HOST_NOT_GRANTED', id, 'absolute paths and ambient bare modules are not resolved');
  return Object.freeze({ kind: 'module', id: projectId(specifier, id, limits) });
}

function dependenciesFor(
  source: string,
  id: string,
  grants: ReadonlyMap<string, string>,
  limits: ModuleGraphLimits,
): ModuleDependency[] {
  // This parser extracts metadata; it is not an ECMAScript conformance validator.
  let file: ts.SourceFile;
  try {
    file = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  } catch {
    return fail('PARSE_RESOURCE', id, 'metadata parser could not process this source');
  }
  const diagnostics = (
    file as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }
  ).parseDiagnostics;
  if (diagnostics.length) {
    const diagnostic = diagnostics[0]!;
    const location = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new ModuleGraphError(
      'PARSE_ERROR',
      id,
      'metadata parser rejected source syntax',
      location.line + 1,
      location.character + 1,
    );
  }
  const result: ModuleDependency[] = [];
  const append = (
    kind: ModuleDependency['kind'],
    literal: ts.Expression,
    extra: { attributesSource?: string; dynamicOptionsSource?: string } = {},
  ): void => {
    if (!ts.isStringLiteral(literal) && !ts.isNoSubstitutionTemplateLiteral(literal))
      fail(
        'NON_LITERAL_IMPORT',
        id,
        'dynamic module specifiers require an explicit literal input graph',
      );
    const start = literal.getStart(file);
    const location = file.getLineAndCharacterOfPosition(start);
    const dependency: ModuleDependency = {
      kind,
      specifier: literal.text,
      target: targetFor(literal.text, id, grants, limits),
      start,
      end: literal.end,
      line: location.line + 1,
      column: location.character + 1,
      ...extra,
    };
    result.push(Object.freeze(dependency));
    if (result.length > limits.dependencies) fail('DEPENDENCY_LIMIT', id, 'too many dependencies');
  };
  const pending: { node: ts.Node; depth: number }[] = [{ node: file, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (depth > limits.syntaxDepth) fail('SYNTAX_DEPTH', id, 'metadata syntax depth exceeded');
    if (ts.isImportDeclaration(node)) {
      if (
        node.importClause?.isTypeOnly ||
        (node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some((element) => element.isTypeOnly))
      )
        fail('TYPE_ONLY_IMPORT', id, 'TypeScript-only imports are not JavaScript module inputs');
      append(
        'import',
        node.moduleSpecifier,
        node.attributes ? { attributesSource: node.attributes.getText(file) } : {},
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.some((element) => element.isTypeOnly))
      )
        fail('TYPE_ONLY_IMPORT', id, 'TypeScript-only reexports are not JavaScript module inputs');
      append(
        'reexport',
        node.moduleSpecifier,
        node.attributes ? { attributesSource: node.attributes.getText(file) } : {},
      );
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length < 1 || node.arguments.length > 2)
        fail(
          'INVALID_DYNAMIC_IMPORT',
          id,
          'dynamic imports require one specifier and optional options',
        );
      append(
        'dynamic-import',
        node.arguments[0]!,
        node.arguments[1] ? { dynamicOptionsSource: node.arguments[1].getText(file) } : {},
      );
    }
    ts.forEachChild(node, (child) => {
      pending.push({ node: child, depth: depth + 1 });
    });
  }
  return result.sort((a, b) => a.start - b.start);
}

/** A trusted host loader receives canonical virtual IDs and must enforce its own I/O boundary. */
export type ModuleSourceReader = (id: string, maxBytes: number) => Promise<string>;

/** Collects exact source inputs. It does not instantiate bindings or evaluate dependencies. */
export async function loadModuleGraph(
  options: ModuleGraphOptions,
  readSource: ModuleSourceReader,
): Promise<ModuleGraph> {
  const limits = limitsFor(options.limits);
  const entry = projectId(options.entry, '', limits);
  const grants = hostGrants(options, limits);
  const queue = [entry];
  const discovered = new Set(queue);
  const modules: ModuleInput[] = [];
  let totalSourceBytes = 0;
  let dependencyCount = 0;
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    const remaining = limits.totalSourceBytes - totalSourceBytes;
    if (remaining < 0) fail('TOTAL_SOURCE_LIMIT', id, 'total source byte limit exceeded');
    const source = await readSource(id, Math.min(limits.sourceBytes, remaining));
    if (typeof source !== 'string') fail('INVALID_SOURCE', id, 'module source must be text');
    if (source.length > limits.sourceBytes)
      fail('SOURCE_LIMIT', id, 'module source byte limit exceeded');
    const bytes = new TextEncoder().encode(source).length;
    if (bytes > limits.sourceBytes) fail('SOURCE_LIMIT', id, 'module source byte limit exceeded');
    if (bytes > remaining) fail('TOTAL_SOURCE_LIMIT', id, 'total source byte limit exceeded');
    totalSourceBytes += bytes;
    const kind = id.endsWith('.json') ? 'json' : 'javascript';
    // JSON is an opaque source input for the future engine/loader, not executed or normalized here.
    const dependencies = kind === 'json' ? [] : dependenciesFor(source, id, grants, limits);
    dependencyCount += dependencies.length;
    if (dependencyCount > limits.dependencies)
      fail('DEPENDENCY_LIMIT', id, 'graph dependency limit exceeded');
    for (const dependency of dependencies) {
      if (dependency.target.kind === 'module' && !discovered.has(dependency.target.id)) {
        discovered.add(dependency.target.id);
        if (discovered.size > limits.modules)
          fail('MODULE_LIMIT', id, 'graph module limit exceeded');
        queue.push(dependency.target.id);
      }
    }
    modules.push(
      Object.freeze({ id, kind, source, bytes, dependencies: Object.freeze(dependencies) }),
    );
  }
  return Object.freeze({
    format: MODULE_GRAPH_FORMAT,
    entry,
    modules: Object.freeze(modules),
    totalSourceBytes,
    dependencyCount,
  });
}

export async function collectModuleGraph(
  options: ModuleGraphOptions & { sources: ReadonlyMap<string, string> },
): Promise<ModuleGraph> {
  return loadModuleGraph(options, async (id) => {
    const source = options.sources.get(id);
    if (source === undefined)
      return fail('MODULE_NOT_FOUND', id, 'module is absent from the virtual project');
    return source;
  });
}
