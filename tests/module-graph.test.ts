import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectModuleGraph,
  MODULE_GRAPH_FORMAT,
  MODULE_GRAPH_LIMITS,
  ModuleGraphError,
} from '../src/module-graph.js';
import { readModuleGraph } from '../src/module-graph-node.js';

function virtual(entry: string, sources: Record<string, string>) {
  return { entry, sources: new Map(Object.entries(sources)) };
}

function graphError(code: string | readonly string[]) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ModuleGraphError);
    assert.ok(
      typeof code === 'string' ? error.code === code : code.includes(error.code),
      error.message,
    );
    assert.equal(typeof error.moduleId, 'string');
    return true;
  };
}

async function withProject(check: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'jovault-input-graph-'));
  try {
    await check(directory);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('jovault-input-graph-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('virtual graph retains exact source and static/reexport/dynamic dependency metadata', async () => {
  const source =
    '\ufeff// import("./not-a-dependency.mjs")\r\n' +
    'import data from "./data.json" with { type: "json" };\r\n' +
    'import "./dep.mjs";\r\n' +
    'export * as namespace from "./dep.mjs";\r\n' +
    'export { value } from "./dep.mjs";\r\n' +
    'import clock from "clock";\r\n' +
    'export const pending = import(`./lazy.mjs`, { with: { type: "custom" } });\r\n' +
    'export const url = import.meta.url;\r\n';
  const sources = {
    '/main.mjs': source,
    '/data.json': '{ "value" : 3 }\r\n',
    '/dep.mjs': 'import "./main.mjs"; export let value = 1;',
    '/lazy.mjs': 'export default class Example { #value = 1; }',
  };
  const options = {
    ...virtual('/main.mjs', sources),
    hostModules: new Map([['clock', { capability: 'clock.read' }]]),
  };
  const graph = await collectModuleGraph(options);
  assert.equal(graph.format, MODULE_GRAPH_FORMAT);
  assert.equal(graph.entry, '/main.mjs');
  assert.deepEqual(
    graph.modules.map((module) => module.id),
    ['/main.mjs', '/data.json', '/dep.mjs', '/lazy.mjs'],
  );
  const main = graph.modules[0]!;
  assert.equal(main.source, source);
  assert.equal(main.bytes, Buffer.byteLength(source));
  assert.deepEqual(
    main.dependencies.map((dependency) => dependency.kind),
    ['import', 'import', 'reexport', 'reexport', 'import', 'dynamic-import'],
  );
  assert.equal(main.dependencies[0]!.attributesSource, 'with { type: "json" }');
  assert.equal(main.dependencies[0]!.line, 2);
  assert.equal(main.dependencies[0]!.column, 18);
  assert.equal(
    source.slice(main.dependencies[0]!.start, main.dependencies[0]!.end),
    '"./data.json"',
  );
  assert.deepEqual(main.dependencies[4]!.target, { kind: 'host', capability: 'clock.read' });
  assert.equal(main.dependencies[5]!.dynamicOptionsSource, '{ with: { type: "custom" } }');
  assert.equal(graph.modules[1]!.source, sources['/data.json']);
  assert.equal(graph.modules[1]!.kind, 'json');
  assert.equal(graph.dependencyCount, 7);
  assert.equal(
    graph.totalSourceBytes,
    Object.values(sources).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  );
  assert.ok(Object.isFrozen(graph) && Object.isFrozen(main) && Object.isFrozen(main.dependencies));
  assert.ok(!('sha256' in main));
  assert.deepEqual(await collectModuleGraph(options), graph);
});

test('relative identities deduplicate cycles and parent paths within the declared root', async () => {
  const graph = await collectModuleGraph(
    virtual('/src/main.mjs', {
      '/src/main.mjs': 'import "../shared.mjs"; import "./../shared.mjs";',
      '/shared.mjs': 'export * from "./src/main.mjs";',
    }),
  );
  assert.deepEqual(
    graph.modules.map((module) => module.id),
    ['/src/main.mjs', '/shared.mjs'],
  );
  assert.deepEqual(
    graph.modules[0]!.dependencies.map((dependency) => dependency.target),
    [
      { kind: 'module', id: '/shared.mjs' },
      { kind: 'module', id: '/shared.mjs' },
    ],
  );
  await assert.rejects(
    collectModuleGraph(
      virtual('main.mjs', { '/main.mjs': 'import "./dep";', '/dep.mjs': 'export {};' }),
    ),
    graphError('MODULE_NOT_FOUND'),
  );
});

test('ambient modules and URL/path aliases are denied instead of implicitly resolved', async () => {
  for (const specifier of [
    'package',
    'node:fs',
    'https://example.com/a.mjs',
    'http://example.com/a.mjs',
    'file:///a.mjs',
    'data:text/javascript,1',
    'blob:example',
    '/absolute.mjs',
    '//server/file.mjs',
    'C:/file.mjs',
    './a%2fb.mjs',
    './%2e%2e/out.mjs',
    './a.mjs?x',
    './a.mjs#x',
    '..\\outside.mjs',
  ]) {
    await assert.rejects(
      collectModuleGraph(
        virtual('/main.mjs', { '/main.mjs': `import ${JSON.stringify(specifier)};` }),
      ),
      graphError(['HOST_NOT_GRANTED', 'INVALID_SPECIFIER']),
    );
  }
  for (const specifier of ['../outside.mjs', './a/../../outside.mjs']) {
    await assert.rejects(
      collectModuleGraph(
        virtual('/main.mjs', { '/main.mjs': `import ${JSON.stringify(specifier)};` }),
      ),
      graphError('OUTSIDE_PROJECT'),
    );
  }
  await assert.rejects(
    collectModuleGraph(
      virtual('/main.mjs', { '/main.mjs': 'import "./\\u002e\\u002e/outside.mjs";' }),
    ),
    graphError('OUTSIDE_PROJECT'),
  );
});

test('exact bare host grants record capabilities and never load a package', async () => {
  const graph = await collectModuleGraph({
    ...virtual('/main.mjs', {
      '/main.mjs': 'import fs from "node:fs"; export * from "@app/clock";',
    }),
    hostModules: new Map([
      ['node:fs', { capability: 'fs.read' }],
      ['@app/clock', { capability: 'clock.read' }],
    ]),
  });
  assert.equal(graph.modules.length, 1);
  assert.deepEqual(
    graph.modules[0]!.dependencies.map((dependency) => dependency.target),
    [
      { kind: 'host', capability: 'fs.read' },
      { kind: 'host', capability: 'clock.read' },
    ],
  );
  for (const specifier of [
    './relative.mjs',
    'https://example.com/a.mjs',
    'file:///x',
    'data:text/plain,1',
  ]) {
    await assert.rejects(
      collectModuleGraph({
        ...virtual('/main.mjs', { '/main.mjs': 'export {};' }),
        hostModules: new Map([[specifier, { capability: 'host.read' }]]),
      }),
      graphError('INVALID_HOST_GRANT'),
    );
  }
});

test('unbounded dynamic graphs, malformed metadata syntax and type-only imports fail explicitly', async () => {
  for (const source of [
    'export function load(value) { return import(value); }',
    'export const pending = import(`./${name}.mjs`);',
  ]) {
    await assert.rejects(
      collectModuleGraph(virtual('/main.mjs', { '/main.mjs': source })),
      graphError('NON_LITERAL_IMPORT'),
    );
  }
  await assert.rejects(
    collectModuleGraph(virtual('/main.mjs', { '/main.mjs': 'import { broken' })),
    graphError('PARSE_ERROR'),
  );
  for (const source of [
    'import type { Value } from "./dep.mjs";',
    'import { type Value } from "./dep.mjs";',
    'export type { Value } from "./dep.mjs";',
  ]) {
    await assert.rejects(
      collectModuleGraph(virtual('/main.mjs', { '/main.mjs': source })),
      graphError('TYPE_ONLY_IMPORT'),
    );
  }
});

test('module, dependency, UTF-8 source, total source and syntax limits cannot be raised', async () => {
  const options = virtual('/main.mjs', {
    '/main.mjs': 'import "./dep.mjs";',
    '/dep.mjs': 'export {};',
  });
  await assert.rejects(
    collectModuleGraph({ ...options, limits: { modules: 1 } }),
    graphError('MODULE_LIMIT'),
  );
  await assert.rejects(
    collectModuleGraph({ ...options, limits: { sourceBytes: 5 } }),
    graphError('SOURCE_LIMIT'),
  );
  await assert.rejects(
    collectModuleGraph({
      ...options,
      limits: { totalSourceBytes: Buffer.byteLength(options.sources.get('/main.mjs')!) },
    }),
    graphError('TOTAL_SOURCE_LIMIT'),
  );
  await assert.rejects(
    collectModuleGraph({
      ...virtual('/main.mjs', { '/main.mjs': 'import "host"; import "host";' }),
      hostModules: new Map([['host', { capability: 'host.read' }]]),
      limits: { dependencies: 1 },
    }),
    graphError('DEPENDENCY_LIMIT'),
  );
  await assert.rejects(
    collectModuleGraph({
      ...virtual('/main.mjs', { '/main.mjs': '//雪' }),
      limits: { sourceBytes: 4 },
    }),
    graphError('SOURCE_LIMIT'),
  );
  await assert.rejects(
    collectModuleGraph({
      ...virtual('/main.mjs', { '/main.mjs': 'export const value = (((1)));' }),
      limits: { syntaxDepth: 2 },
    }),
    graphError('SYNTAX_DEPTH'),
  );
  for (const modules of [0, -1, 1.5, NaN, MODULE_GRAPH_LIMITS.modules + 1]) {
    await assert.rejects(
      collectModuleGraph({ ...options, limits: { modules } }),
      graphError('INVALID_LIMIT'),
    );
  }
  await assert.rejects(
    collectModuleGraph({ ...options, limits: JSON.parse('{"toString":1}') }),
    graphError('INVALID_LIMIT'),
  );
  await assert.rejects(
    collectModuleGraph({
      ...virtual('/main.mjs', {
        '/main.mjs': 'import "./dep.mjs";',
        '/dep.mjs': 'import "./main.mjs";',
      }),
      limits: { dependencies: 1 },
    }),
    graphError('DEPENDENCY_LIMIT'),
  );
  const source = 'import "./empty.mjs";';
  const exact = await collectModuleGraph({
    ...virtual('/main.mjs', { '/main.mjs': source, '/empty.mjs': '' }),
    limits: { totalSourceBytes: Buffer.byteLength(source) },
  });
  assert.equal(exact.modules.length, 2);
});

test('Node adapter snapshots exact UTF-8 text and hashes without executing module sources', async () => {
  await withProject(async (directory) => {
    const source = '\ufeffimport "./dep.mjs";\r\nthrow new Error("MUST_NOT_EXECUTE");\r\n';
    await writeFile(path.join(directory, 'main.mjs'), source);
    await writeFile(path.join(directory, 'dep.mjs'), 'export let value = 1;\n');
    const graph = await readModuleGraph({ root: directory, entry: 'main.mjs' });
    assert.equal(graph.modules[0]!.source, source);
    for (const module of graph.modules) {
      const bytes = await readFile(path.join(directory, module.id.slice(1)));
      assert.equal(module.bytes, bytes.length);
      assert.equal(graph.sourceHashes[module.id], createHash('sha256').update(bytes).digest('hex'));
    }
    assert.ok(Object.isFrozen(graph.sourceHashes));
  });
});

test('Node adapter denies escapes, symlink/junction paths and roots, invalid UTF-8 and oversized reads', async () => {
  for (const root of [
    '\\\\server\\share',
    '//server/share',
    'https://example.com/project',
    'file:///project',
  ]) {
    await assert.rejects(
      readModuleGraph({ root, entry: 'main.mjs' }),
      graphError('INVALID_PROJECT'),
    );
  }
  await withProject(async (directory) => {
    const root = path.join(directory, 'project');
    const outside = path.join(directory, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, 'other.mjs'), 'export const secret = 1;');
    await writeFile(path.join(root, 'main.mjs'), 'import "./linked/other.mjs";');
    await symlink(outside, path.join(root, 'linked'), 'junction');
    await assert.rejects(readModuleGraph({ root, entry: 'main.mjs' }), graphError('SYMLINK'));
    await assert.rejects(
      readModuleGraph({ root: path.join(root, 'linked'), entry: 'other.mjs' }),
      graphError('SYMLINK'),
    );
    await assert.rejects(
      readModuleGraph({ root, entry: '../outside/other.mjs' }),
      graphError('OUTSIDE_PROJECT'),
    );
    await assert.rejects(
      readModuleGraph({ root, entry: path.join(outside, 'other.mjs') }),
      graphError('INVALID_PROJECT'),
    );
    await writeFile(path.join(root, 'invalid.mjs'), Buffer.from([0xff, 0xfe]));
    await assert.rejects(
      readModuleGraph({ root, entry: 'invalid.mjs' }),
      graphError('INVALID_UTF8'),
    );
    await assert.rejects(
      readModuleGraph({ root, entry: 'main.mjs', limits: { sourceBytes: 3 } }),
      graphError('SOURCE_LIMIT'),
    );
    await assert.rejects(
      readModuleGraph({ root, entry: 'missing.mjs' }),
      graphError('MODULE_NOT_FOUND'),
    );
  });
});

test('existing live-binding and cycle conformance inputs form source graphs without primitive-compiler restrictions', async () => {
  const root = fileURLToPath(new URL('./conformance-fixtures/', import.meta.url));
  const live = await readModuleGraph({ root, entry: '18-live-import.mjs' });
  assert.deepEqual(
    live.modules.map((module) => module.id),
    ['/18-live-import.mjs', '/18-live-dependency.mjs'],
  );
  const cycle = await readModuleGraph({ root, entry: '19-cycle.mjs' });
  assert.deepEqual(
    cycle.modules.map((module) => module.id),
    ['/19-cycle.mjs', '/19-cycle-dependency.mjs'],
  );
  assert.deepEqual(cycle.modules[1]!.dependencies[0]!.target, {
    kind: 'module',
    id: '/19-cycle.mjs',
  });
});
