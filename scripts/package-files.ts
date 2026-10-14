import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots = new Set([
  'src',
  'demo',
  'docs',
  'tests',
  'examples',
  'engine-probe',
  'assets',
  'scripts',
  '.github',
]);
const rootFiles = new Set([
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'ORIGIN.json',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.gitignore',
  '.gitattributes',
  '.prettierrc.json',
  '.prettierignore',
]);
const excluded = new Set([
  'target',
  'node_modules',
  'vendor',
  'vendor-budget',
  'crate-cache',
  'evidence',
  'runs',
  'artifacts',
  '.git',
  'private',
  'test-results',
  'playwright-report',
]);
export function isPublicPath(name: string): boolean {
  const parts = name.split('/');
  if (
    parts.some((part) => !part || part === '.' || part === '..' || excluded.has(part)) ||
    name.includes(String.fromCharCode(92)) ||
    name.includes(':') ||
    name.includes(String.fromCharCode(0))
  )
    return false;
  if (parts.length === 1) return rootFiles.has(name);
  if (!roots.has(parts[0]!)) return false;
  if (
    /[.](?:pem|key|p12|pfx|log|wasm|crate)$/iu.test(name) ||
    parts.at(-1)?.endsWith('.local.json')
  )
    return false;
  if (
    parts[0] === 'engine-probe' &&
    parts.length === 2 &&
    /(?:results|inventory)[.]json$/u.test(parts[1]!)
  )
    return false;
  return (
    /[.](?:ts|mjs|js|json|md|html|css|rs|toml|lock|patch|py|yml|svg)$/u.test(name) ||
    parts.at(-1) === '.gitignore' ||
    parts.at(-1) === 'LICENSE.test262'
  );
}
export function publicFiles(root: string): string[] {
  const result: string[] = [];
  function walk(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const full = resolve(directory, name);
      const item = lstatSync(full);
      const file = relative(root, full).split(sep).join('/');
      if (item.isSymbolicLink()) throw new Error('PACKAGE_SYMLINK');
      if (item.isDirectory()) {
        if (!excluded.has(name)) walk(full);
      } else if (isPublicPath(file)) result.push(file);
    }
  }
  for (const name of readdirSync(root).sort()) {
    if (!roots.has(name) && !rootFiles.has(name)) continue;
    const full = resolve(root, name);
    const item = lstatSync(full);
    if (item.isSymbolicLink()) throw new Error('PACKAGE_SYMLINK');
    if (item.isDirectory() && roots.has(name)) walk(full);
    else if (item.isFile() && rootFiles.has(name)) result.push(name);
  }
  return result.sort();
}
export function inventory(root: string) {
  return publicFiles(root).map((file) => {
    const data = readFileSync(resolve(root, file));
    return {
      path: file,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = inventory(resolve(fileURLToPath(new URL('../', import.meta.url))));
  if (files.length === 0) throw new Error('EMPTY_PACKAGE');
  process.stdout.write(
    JSON.stringify({ ok: true, checkedFiles: files.length }) + String.fromCharCode(10),
  );
}
