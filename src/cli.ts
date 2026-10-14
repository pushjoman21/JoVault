import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compileModule, emitModule } from './register-compiler.js';
import { OPS } from './register-contract.js';

const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Creates a new output directory. Existing files and source dependencies are never overwritten. */
export async function buildModule(input: string, output: string): Promise<Record<string, unknown>> {
  const sourcePath = resolve(input);
  const destination = resolve(output);
  const source = readFileSync(sourcePath, 'utf8');
  const compilation = compileModule(source);
  // Preserve module resolution when the wrapper is written outside the source directory.
  for (const binding of compilation.artifact.imports) {
    if (binding.source.startsWith('.') || isAbsolute(binding.source)) {
      const target = resolve(dirname(sourcePath), binding.source);
      let specifier = relative(destination, target).split(sep).join('/');
      if (isAbsolute(specifier))
        throw new Error('Output and relative dependencies must share a filesystem volume.');
      if (!specifier.startsWith('.')) specifier = './' + specifier;
      binding.source = specifier;
    }
  }
  const runtime = await build({
    entryPoints: [fileURLToPath(new URL('./register-runtime.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    write: false,
    sourcemap: false,
    legalComments: 'none',
  });
  const runtimeBytes = runtime.outputFiles[0]!.contents;
  const moduleSource = emitModule(compilation);
  const { artifact, dialect } = compilation;
  const files = [
    { path: 'module.mjs', bytes: Buffer.byteLength(moduleSource), sha256: hash(moduleSource) },
    { path: 'jovault-runtime.mjs', bytes: runtimeBytes.length, sha256: hash(runtimeBytes) },
  ];
  const manifest = {
    status: 'experimental',
    format: artifact.format,
    dialect: dialect.id,
    epoch: artifact.epoch,
    notBefore: artifact.notBefore,
    expiresAt: artifact.expiresAt,
    sourceSha256: hash(source),
    opcodeCount: OPS.length,
    files,
  };
  // A manifest is written last. A partial output must never be considered a completed build.
  mkdirSync(destination);
  writeFileSync(resolve(destination, 'module.mjs'), moduleSource, { flag: 'wx' });
  writeFileSync(resolve(destination, 'jovault-runtime.mjs'), runtimeBytes, { flag: 'wx' });
  writeFileSync(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write('Usage: npm run jovault:build -- <input.js> <new-output-directory>\n');
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(JSON.stringify(await buildModule(args[0]!, args[1]!), null, 2) + '\n');
    } catch (error) {
      process.stderr.write((error instanceof Error ? error.message : 'BUILD_FAILED') + '\n');
      process.exitCode = 1;
    }
  }
}
