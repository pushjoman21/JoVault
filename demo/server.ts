import { open, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { build } from 'esbuild';
import { z } from 'zod';
import { compileModule, emitModule } from '../src/register-compiler.js';
import { NodePackageSigner } from '../src/package-signing.js';
import { prepareBoaRuntime } from '../src/boa-checkpoint.js';
import { BoaCompilerError, compileBoaCheckpoint } from '../src/boa-compiler-node.js';

const PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const WORKER_CSP =
  "default-src 'none'; script-src 'self' blob:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'";
const BOA_WORKER_CSP =
  "default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'";
const inputSchema = z
  .object({
    source: z.string().min(1).max(1_048_576),
    engine: z.enum(['register', 'boa']).optional(),
  })
  .strict();

export interface DemoServerOptions {
  readonly boa?: {
    readonly wasmPath: string;
    readonly auditPath: string;
    readonly wasmSha256: string;
    readonly auditSha256: string;
  };
}

async function readBoundedAsset(path: string): Promise<Buffer<ArrayBuffer>> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 67_108_864) throw new Error('Asset size');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error('Asset changed');
      offset += read.bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0)
      throw new Error('Asset changed');
    return bytes;
  } finally {
    await file.close();
  }
}

/** Local compilers; optional Boa compilation uses its bounded Node worker. */
export async function createDemoServer(options: DemoServerOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 2_097_152, requestTimeout: 5_000 });
  let boaAssets:
    | {
        wasm: Buffer<ArrayBuffer>;
        audit: Buffer<ArrayBuffer>;
        runtime: Awaited<ReturnType<typeof prepareBoaRuntime>>;
      }
    | undefined;
  if (options.boa) {
    try {
      if (
        !/^[0-9a-f]{64}$/.test(options.boa.wasmSha256) ||
        !/^[0-9a-f]{64}$/.test(options.boa.auditSha256)
      )
        throw new Error('Pins');
      const [wasm, audit] = await Promise.all([
        readBoundedAsset(options.boa.wasmPath),
        readBoundedAsset(options.boa.auditPath),
      ]);
      const runtime = await prepareBoaRuntime(wasm, audit, {
        runtimeSha256: options.boa.wasmSha256,
        auditSha256: options.boa.auditSha256,
      });
      boaAssets = { wasm, audit, runtime };
    } catch {
      throw new Error(
        'Boa runtime configuration rejected. Check the reviewed assets and both SHA-256 pins.',
      );
    }
  }
  const bundle = await build({
    stdin: {
      contents:
        "export { instantiate } from './register-runtime.ts'; export { instantiatePackage } from './package-loader.ts'; export { prepareBoaRuntime, instantiateBoaPackage } from './boa-checkpoint.ts';",
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const runtime = bundle.outputFiles[0]?.text;
  if (!runtime) throw new Error('Runtime bundle is empty');
  const deployment = `local-${randomUUID()}`;
  const signer = new NodePackageSigner({ keyId: deployment });
  const expected = {
    application: 'jovault-demo',
    deployment,
    runtimeSha256: createHash('sha256').update(runtime, 'utf8').digest('hex'),
  };
  const trust = [signer.verificationKey({ notBefore: 0, expiresAt: Number.MAX_SAFE_INTEGER })];
  const boa =
    options.boa && boaAssets
      ? {
          available: true as const,
          wasmUrl: '/boa.wasm',
          auditUrl: '/boa-audit.json',
          runtimeSha256: options.boa.wasmSha256,
          auditSha256: options.boa.auditSha256,
          expected: {
            application: expected.application,
            deployment,
            runtimeSha256: options.boa.wasmSha256,
          },
        }
      : { available: false as const };
  // This same-origin demo asset is the trust channel; compile responses carry no trust policy.
  const trustModule = `export const trust = ${JSON.stringify(trust)};\nexport const expected = ${JSON.stringify(expected)};\nexport const boa = ${JSON.stringify(boa)};\n`;
  const assets = await Promise.all(
    ['index.html', 'app.mjs', 'style.css', 'runner.mjs'].map(
      async (name) => [name, await readFile(new URL(name, import.meta.url), 'utf8')] as const,
    ),
  );
  const logo = await readFile(new URL('../assets/jo-mark.svg', import.meta.url), 'utf8');
  const fixed = new Map<string, { body: string | Buffer<ArrayBuffer>; type: string }>([
    ...assets.map(
      ([name, body]) =>
        [
          name === 'index.html' ? '/' : `/${name}`,
          {
            body,
            type: name.endsWith('.html')
              ? 'text/html; charset=utf-8'
              : name.endsWith('.css')
                ? 'text/css; charset=utf-8'
                : 'text/javascript; charset=utf-8',
          },
        ] as const,
    ),
    ['/runtime.mjs', { body: runtime, type: 'text/javascript; charset=utf-8' }],
    ['/trust.mjs', { body: trustModule, type: 'text/javascript; charset=utf-8' }],
    ['/jo-mark.svg', { body: logo, type: 'image/svg+xml' }],
  ]);
  if (boaAssets) {
    fixed.set('/boa.wasm', { body: boaAssets.wasm, type: 'application/wasm' });
    fixed.set('/boa-audit.json', { body: boaAssets.audit, type: 'application/json' });
    fixed.set('/boa-runner.mjs', {
      body: assets.find(([name]) => name === 'runner.mjs')![1],
      type: 'text/javascript; charset=utf-8',
    });
  }

  app.addHook('onRequest', async (request, reply) => {
    reply
      .header(
        'Content-Security-Policy',
        request.url.split('?')[0] === '/boa-runner.mjs' && boaAssets
          ? BOA_WORKER_CSP
          : request.url.split('?')[0] === '/runner.mjs'
            ? WORKER_CSP
            : PAGE_CSP,
      )
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Cache-Control', 'no-store');
    const host = request.headers.host ?? '';
    const loopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/.exec(host);
    if (!loopback || (loopback[1] !== undefined && Number(loopback[1]) > 65_535)) {
      return reply.code(403).send({ error: 'Use a loopback address.' });
    }
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    if (
      (origin !== undefined && origin !== `http://${host}`) ||
      (site !== undefined && site !== 'same-origin' && site !== 'none')
    ) {
      return reply.code(403).send({ error: 'Cross-origin requests are disabled.' });
    }
  });
  for (const [route, asset] of fixed) {
    app.get(route, async (_request, reply) => reply.type(asset.type).send(asset.body));
  }

  let windowStart = Date.now();
  let attempts = 0;
  let boaCompiling = false;
  app.post('/api/compile', async (request, reply) => {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      return reply.code(415).send({ error: 'Send application/json.' });
    }
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Send source and an optional engine: register or boa.' });
    }
    const engine = parsed.data.engine ?? 'register';
    const sourceLimit = engine === 'boa' ? 1_048_576 : 32_768;
    if (Buffer.byteLength(parsed.data.source, 'utf8') > sourceLimit) {
      return reply
        .code(400)
        .send({ error: `Source exceeds the ${sourceLimit}-byte ${engine} limit.` });
    }
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      attempts = 0;
    }
    if (++attempts > 30) {
      return reply
        .code(429)
        .header('Retry-After', '60')
        .send({ error: 'Compile limit reached. Try again in a minute.' });
    }
    if (engine === 'boa') {
      if (!boaAssets || !boa.available)
        return reply.code(503).send({
          code: 'BOA_UNAVAILABLE',
          error:
            'Boa is unavailable. The operator must configure reviewed runtime and audit assets with both SHA-256 pins.',
        });
      if (boaCompiling)
        return reply.code(429).send({
          code: 'BOA_BUSY',
          error: 'A Boa compilation is already running. Try again after it finishes.',
        });
      boaCompiling = true;
      try {
        const compiled = await compileBoaCheckpoint(
          { entry: '/main.mjs', modules: [{ id: '/main.mjs', source: parsed.data.source }] },
          boaAssets.runtime,
        );
        if (!compiled.exportNames.includes('main'))
          return reply
            .code(422)
            .send({ code: 'BOA_MAIN_REQUIRED', error: 'Export a function named main.' });
        const envelope = signer.sign(compiled.payload, {
          ...boa.expected,
          kind: 'boa-checkpoint',
          abi: 1,
        });
        return {
          engine: 'boa',
          envelope,
          payload: Buffer.from(compiled.payload).toString('base64'),
          metadata: compiled.metadata,
          exportNames: compiled.exportNames,
        };
      } catch (error) {
        const code = error instanceof BoaCompilerError ? error.code : 'BOA_COMPILE_FAILED';
        return reply.code(422).send({ code, error: `Boa compilation failed (${code}).` });
      } finally {
        boaCompiling = false;
      }
    }
    try {
      const compilation = compileModule(parsed.data.source, { now, filename: 'demo.js' });
      if (compilation.artifact.imports.length !== 0) {
        return reply.code(422).send({
          error: 'The demo has no host imports. Use local functions and primitive values.',
        });
      }
      if (!compilation.artifact.exports.some((entry) => entry.name === 'main')) {
        return reply.code(422).send({ error: 'Export a function named main.' });
      }
      const payload = JSON.stringify(compilation);
      const envelope = signer.sign(new TextEncoder().encode(payload), {
        ...expected,
        kind: 'register-module',
        abi: 1,
        now,
      });
      return {
        ...compilation,
        wrapper: emitModule(compilation, '/runtime.mjs'),
        envelope,
        payload,
      };
    } catch (error) {
      return reply.code(422).send({
        error: error instanceof Error ? error.message.slice(0, 8_192) : 'Compilation failed.',
      });
    }
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.JOVAULT_DEMO_PORT ?? '4971');
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error('Invalid JOVAULT_DEMO_PORT');
  const boaEnv = [
    process.env.JOVAULT_BOA_WASM,
    process.env.JOVAULT_BOA_AUDIT,
    process.env.JOVAULT_BOA_WASM_SHA256,
    process.env.JOVAULT_BOA_AUDIT_SHA256,
  ];
  if (
    boaEnv.some((value) => value !== undefined) &&
    !boaEnv.every((value) => typeof value === 'string' && value.length > 0)
  )
    throw new Error('Provide all four JOVAULT_BOA runtime, audit, and SHA-256 settings.');
  const app = await createDemoServer(
    boaEnv.every((value) => value !== undefined)
      ? {
          boa: {
            wasmPath: boaEnv[0]!,
            auditPath: boaEnv[1]!,
            wasmSha256: boaEnv[2]!,
            auditSha256: boaEnv[3]!,
          },
        }
      : {},
  );
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`JoVault demo: http://127.0.0.1:${port}`);
}
