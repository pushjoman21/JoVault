import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  loadModuleGraph,
  ModuleGraphError,
  type ModuleGraph,
  type ModuleGraphOptions,
} from './module-graph.js';

export interface FileModuleGraph extends ModuleGraph {
  /** Hashes bind exact UTF-8 file bytes to their portable virtual identities. */
  readonly sourceHashes: Readonly<Record<string, string>>;
}

function fail(code: string, id: string, detail: string): never {
  throw new ModuleGraphError(code, id, detail);
}

function staysWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

/**
 * Snapshots a trusted local project; does not resolve packages, URLs, symlinks or junctions.
 * lstat/realpath checks cannot eliminate filesystem TOCTOU races. Callers must keep the
 * project tree stable while reading; this adapter is not an OS filesystem sandbox.
 */
export async function readModuleGraph(
  options: ModuleGraphOptions & { root: string },
): Promise<FileModuleGraph> {
  if (
    typeof options.root !== 'string' ||
    !options.root ||
    /^[\\/]{2}/u.test(options.root) ||
    (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(options.root) && !/^[a-zA-Z]:[\\/]/u.test(options.root)) ||
    typeof options.entry !== 'string' ||
    isAbsolute(options.entry) ||
    /^[a-zA-Z]:/u.test(options.entry)
  )
    fail('INVALID_PROJECT', '', 'expected a local root and root-relative entry');
  const root = resolve(options.root);
  let canonicalRoot: string;
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink())
      fail('SYMLINK', '', 'project root must not be a symlink or junction');
    if (!stat.isDirectory()) fail('INVALID_PROJECT', '', 'project root must be a directory');
    canonicalRoot = await realpath(root);
    if (/^[\\/]{2}/u.test(canonicalRoot))
      fail('INVALID_PROJECT', '', 'network project roots are not permitted');
  } catch (error) {
    if (error instanceof ModuleGraphError) throw error;
    return fail('INVALID_PROJECT', '', 'project root is unavailable');
  }
  const hashes: Record<string, string> = Object.create(null) as Record<string, string>;
  const graph = await loadModuleGraph(options, async (id, maxBytes) => {
    const parts = id.slice(1).split('/');
    let target = canonicalRoot;
    try {
      for (const [index, part] of parts.entries()) {
        // Avoid case/short-name aliases on case-insensitive hosts while preserving virtual identity.
        const names = await readdir(target);
        const parent = target;
        target = join(target, part);
        if (!staysWithin(canonicalRoot, target))
          fail('OUTSIDE_PROJECT', id, 'path escapes project root');
        const stat = await lstat(target);
        if (stat.isSymbolicLink())
          fail('SYMLINK', id, 'symlinks and junctions are not module inputs');
        if (!names.includes(part))
          fail('PATH_ALIAS', id, 'module path must match filesystem spelling');
        if (index < parts.length - 1 && !stat.isDirectory())
          fail('MODULE_NOT_FOUND', id, 'module parent is not a directory');
        if (index === parts.length - 1 && !stat.isFile())
          fail('INVALID_SOURCE', id, 'module must be a regular file');
        if (!staysWithin(canonicalRoot, await realpath(parent)))
          fail('OUTSIDE_PROJECT', id, 'module parent escaped project root');
      }
      if (!staysWithin(canonicalRoot, await realpath(target)))
        fail('OUTSIDE_PROJECT', id, 'module escaped project root');
      const handle = await open(target, 'r');
      let bytes: Buffer;
      try {
        if (!(await handle.stat()).isFile())
          fail('INVALID_SOURCE', id, 'module must be a regular file');
        const buffer = Buffer.alloc(maxBytes + 1);
        let used = 0;
        while (used < buffer.length) {
          const read = await handle.read(buffer, used, buffer.length - used, null);
          if (!read.bytesRead) break;
          used += read.bytesRead;
        }
        if (used > maxBytes)
          fail('SOURCE_LIMIT', id, 'bounded source read exceeded its byte allowance');
        bytes = buffer.subarray(0, used);
        if ((await lstat(target)).isSymbolicLink())
          fail('SYMLINK', id, 'module changed to a symlink while reading');
        if (!staysWithin(canonicalRoot, await realpath(target)))
          fail('OUTSIDE_PROJECT', id, 'module escaped project root while reading');
      } finally {
        await handle.close();
      }
      let source: string;
      try {
        source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return fail('INVALID_UTF8', id, 'module source is not valid UTF-8');
      }
      hashes[id] = createHash('sha256').update(bytes).digest('hex');
      return source;
    } catch (error) {
      if (error instanceof ModuleGraphError) throw error;
      return fail('MODULE_NOT_FOUND', id, 'module file is unavailable');
    }
  });
  return Object.freeze({ ...graph, sourceHashes: Object.freeze(hashes) });
}
