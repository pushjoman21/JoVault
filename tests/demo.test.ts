import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDemoServer, type DemoServerOptions } from '../demo/server.js';
import { instantiate } from '../src/register-runtime.js';
import { instantiatePackage } from '../src/package-loader.js';
import type { PackageExpectation, SignedEnvelope, VerificationKey } from '../src/package.js';
import type { Compilation } from '../src/register-compiler.js';
import { prepareBoaRuntime, instantiateBoaPackage } from '../src/boa-checkpoint.js';

const SOURCE = 'export function main(value) { return (value * 3) | 0; }';
type DemoServer = Awaited<ReturnType<typeof createDemoServer>>;
type CompileResponse = Compilation & { wrapper: string; envelope: SignedEnvelope; payload: string };

async function compileSigned(app: DemoServer): Promise<CompileResponse> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/compile',
    payload: { source: SOURCE },
  });
  assert.equal(response.statusCode, 200);
  return response.json<CompileResponse>();
}

async function readTrust(app: DemoServer): Promise<{
  trust: VerificationKey[];
  expected: PackageExpectation;
  boa: {
    available: boolean;
    runtimeSha256?: string;
    auditSha256?: string;
    wasmUrl?: string;
    auditUrl?: string;
    expected?: PackageExpectation;
  };
}> {
  const response = await app.inject('/trust.mjs');
  assert.equal(response.statusCode, 200);
  const match =
    /^export const trust = (.+);\nexport const expected = (.+);\nexport const boa = (.+);\n$/.exec(
      response.body,
    );
  assert.ok(match);
  return {
    trust: JSON.parse(match[1]!) as VerificationKey[],
    expected: JSON.parse(match[2]!) as PackageExpectation,
    boa: JSON.parse(match[3]!),
  };
}

test('demo compiles real register artifacts and returns a matching ESM wrapper', async (t) => {
  const app = await createDemoServer();
  t.after(() => app.close());
  const result = await app.inject({
    method: 'POST',
    url: '/api/compile',
    headers: { host: 'localhost', origin: 'http://localhost' },
    payload: { source: SOURCE },
  });
  assert.equal(result.statusCode, 200);
  const payload = result.json();
  assert.equal(payload.artifact.format, 'JOVLT-R0');
  assert.equal(payload.dialect.format, 'JOVLT-RD0');
  assert.equal(instantiate(payload.artifact, payload.dialect, []).invoke('main', [123]), 369);
  assert.match(payload.wrapper, /\/runtime\.mjs/);
  assert.match(payload.wrapper, /main/);
});

test('demo rejects unsupported source, missing main, host imports and invalid compile bodies', async (t) => {
  const app = await createDemoServer();
  t.after(() => app.close());
  for (const source of [
    'export function main() { return {}; }',
    'export function other() { return 1; }',
    'import { host } from "host"; export function main() { return host(); }',
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/compile', payload: { source } });
    assert.equal(response.statusCode, 422, source);
    assert.equal(typeof response.json().error, 'string');
  }
  for (const payload of [
    { source: '' },
    { source: SOURCE, path: '/secret' },
    {},
    { source: 1 },
    { source: 'é'.repeat(20_000) },
    { source: 'a'.repeat(32_769) },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/compile', payload });
    assert.equal(response.statusCode, 400);
  }
  const oversized = await app.inject({
    method: 'POST',
    url: '/api/compile',
    payload: { source: 'a'.repeat(2_097_152) },
  });
  assert.equal(oversized.statusCode, 413);
  const text = await app.inject({
    method: 'POST',
    url: '/api/compile',
    payload: SOURCE,
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(text.statusCode, 415);
});

test('demo serves only fixed assets and applies browser and worker security headers', async (t) => {
  const app = await createDemoServer();
  t.after(() => app.close());
  for (const route of [
    '/',
    '/app.mjs',
    '/style.css',
    '/runner.mjs',
    '/runtime.mjs',
    '/trust.mjs',
    '/jo-mark.svg',
  ]) {
    const response = await app.inject(route);
    assert.equal(response.statusCode, 200, route);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    const csp = response.headers['content-security-policy'];
    assert.equal(typeof csp, 'string');
    if (route === '/runner.mjs') {
      assert.match(String(csp), /connect-src 'none'/);
      assert.match(String(csp), /worker-src 'none'/);
      assert.match(String(csp), /script-src 'self' blob:/);
    } else {
      assert.match(String(csp), /script-src 'self'/);
      assert.match(String(csp), /frame-ancestors 'none'/);
    }
  }
  for (const route of [
    '/jovm-mark.svg',
    '/jovault-mark.svg',
    '/server.ts',
    '/src/register-compiler.ts',
    '/private/config.json',
    '/api/compile?path=..',
  ]) {
    assert.equal((await app.inject(route)).statusCode, 404, route);
  }
  assert.equal((await app.inject({ method: 'OPTIONS', url: '/api/compile' })).statusCode, 404);
  const queriedWorker = await app.inject('/runner.mjs?run=1');
  assert.equal(queriedWorker.statusCode, 200);
  assert.match(String(queriedWorker.headers['content-security-policy']), /connect-src 'none'/);
  const mark = await app.inject('/jo-mark.svg');
  assert.equal(mark.headers['content-type'], 'image/svg+xml');
  assert.match(mark.body, /<title id="t">Jo Cyber<\/title>/);
  assert.match(mark.body, /viewBox="0 0 32 32"/);
  assert.doesNotMatch(mark.body, /<script|<image|<foreignObject|href=|url\(/i);
  const page = (await app.inject('/')).body;
  assert.match(page, /rel="icon" href="\/jo-mark\.svg"/);
  assert.match(page, /<img src="\/jo-mark\.svg" alt="" width="32" height="32"/);
  assert.doesNotMatch(page, /jovm-mark\.svg|jovault-mark\.svg/);
});

test('demo signs exact payload bytes and binds its independently served public trust to runtime and deployment', async (t) => {
  const app = await createDemoServer();
  t.after(() => app.close());
  const compiled = await compileSigned(app);
  const { trust, expected } = await readTrust(app);
  const runtime = await app.inject('/runtime.mjs');
  assert.equal(
    expected.runtimeSha256,
    createHash('sha256').update(runtime.rawPayload).digest('hex'),
  );
  assert.equal(expected.application, 'jovault-demo');
  assert.match(expected.deployment, /^local-[0-9a-f-]+$/);
  assert.equal(compiled.envelope.manifest.runtimeSha256, expected.runtimeSha256);
  assert.equal(compiled.envelope.manifest.deployment, expected.deployment);
  assert.equal(compiled.envelope.manifest.kind, 'register-module');
  assert.equal(compiled.envelope.manifest.abi, 1);
  assert.equal(compiled.envelope.manifest.epoch, compiled.artifact.epoch);
  assert.equal(
    compiled.envelope.manifest.payloadBytes,
    Buffer.byteLength(compiled.payload, 'utf8'),
  );
  assert.deepEqual(JSON.parse(compiled.payload), {
    artifact: compiled.artifact,
    dialect: compiled.dialect,
  });
  assert.deepEqual(Object.keys(compiled).sort(), [
    'artifact',
    'dialect',
    'envelope',
    'payload',
    'wrapper',
  ]);
  assert.deepEqual(Object.keys(trust[0]!.jwk).sort(), ['crv', 'kty', 'x']);
  assert.doesNotMatch((await app.inject('/trust.mjs')).body, /"d"\s*:|PRIVATE KEY|privateKey/);
  assert.doesNotMatch(runtime.body, /node:crypto|NodePackageSigner|generateKeyPairSync/);
  assert.match(runtime.body, /instantiatePackage/);
  assert.match(runtime.body, /instantiate/);
  const now = () => compiled.envelope.manifest.notBefore + 1;
  const instance = await instantiatePackage(
    compiled.envelope,
    new TextEncoder().encode(compiled.payload),
    trust,
    expected,
    [],
    { now },
  );
  assert.equal(instance.invoke('main', [123]), 369);
  const runner = (await app.inject('/runner.mjs')).body;
  assert.match(runner, /instantiatePackage, prepareBoaRuntime, instantiateBoaPackage/);
  assert.match(runner, /import \{ trust, expected, boa \} from '\/trust\.mjs'/);
  assert.doesNotMatch(runner, /\binstantiate\(/);
  assert.doesNotMatch(runner, /data\.artifact|data\.dialect|data\.trust|data\.expected/);
});

test('demo keeps Boa visibly unavailable without reviewed operator assets and rejects client trust inputs', async (t) => {
  const app = await createDemoServer();
  t.after(() => app.close());
  const policy = await readTrust(app);
  assert.deepEqual(policy.boa, { available: false });
  const unavailable = await app.inject({
    method: 'POST',
    url: '/api/compile',
    payload: { source: SOURCE, engine: 'boa' },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().code, 'BOA_UNAVAILABLE');
  for (const path of ['/boa.wasm', '/boa-audit.json', '/boa-runner.mjs']) {
    assert.equal((await app.inject(path)).statusCode, 404);
  }
  const page = (await app.inject('/')).body;
  assert.match(page, /value="boa" disabled/);
  assert.match(page, /Boa is unavailable/);
  for (const payload of [
    { source: SOURCE, engine: 'native' },
    { source: SOURCE, engine: 'boa', wasmPath: '/private.wasm' },
    { source: SOURCE, engine: 'boa', auditSha256: '0'.repeat(64) },
    { source: SOURCE, engine: 'boa', expected: {} },
    { source: SOURCE, engine: 'register', sourceUrl: 'https://example.com/code.js' },
    { source: 'a'.repeat(32_769), engine: 'register' },
    { source: 'a'.repeat(1_048_577), engine: 'boa' },
    { source: 'é'.repeat(600_000), engine: 'boa' },
  ]) {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/compile', payload })).statusCode,
      400,
    );
  }
  const explicit = await app.inject({
    method: 'POST',
    url: '/api/compile',
    payload: { source: SOURCE, engine: 'register' },
  });
  assert.equal(explicit.statusCode, 200);
  assert.equal(explicit.json().artifact.format, 'JOVLT-R0');
  assert.deepEqual(Object.keys(explicit.json()).sort(), [
    'artifact',
    'dialect',
    'envelope',
    'payload',
    'wrapper',
  ]);
});

test('demo rejects invalid operator runtime pins without exposing configured paths', async () => {
  for (const hash of ['not-a-sha', '0'.repeat(64)]) {
    await assert.rejects(
      createDemoServer({
        boa: {
          wasmPath: 'DO_NOT_EXPOSE_WASM_PATH',
          auditPath: 'DO_NOT_EXPOSE_AUDIT_PATH',
          wasmSha256: hash,
          auditSha256: hash,
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          'Boa runtime configuration rejected. Check the reviewed assets and both SHA-256 pins.',
        );
        assert.doesNotMatch(error.message, /DO_NOT_EXPOSE/);
        return true;
      },
    );
  }
});

const boaEnvironment = [
  process.env.JOVAULT_BOA_WASM,
  process.env.JOVAULT_BOA_AUDIT,
  process.env.JOVAULT_BOA_WASM_SHA256,
  process.env.JOVAULT_BOA_AUDIT_SHA256,
];
const reviewedBoa: DemoServerOptions['boa'] = boaEnvironment.every(
  (value) => typeof value === 'string' && value.length > 0,
)
  ? {
      wasmPath: boaEnvironment[0]!,
      auditPath: boaEnvironment[1]!,
      wasmSha256: boaEnvironment[2]!,
      auditSha256: boaEnvironment[3]!,
    }
  : undefined;

test(
  'reviewed Boa assets enable signed binary compilation, verification, fixed routes and worker admission control',
  { skip: !reviewedBoa },
  async (t) => {
    const app = await createDemoServer({ boa: reviewedBoa! });
    t.after(() => app.close());
    const { trust, boa } = await readTrust(app);
    assert.equal(boa.available, true);
    await assert.rejects(
      createDemoServer({ boa: { ...reviewedBoa!, auditSha256: '0'.repeat(64) } }),
      /Boa runtime configuration rejected/,
    );
    assert.equal(boa.wasmUrl, '/boa.wasm');
    assert.equal(boa.auditUrl, '/boa-audit.json');
    const wasm = await app.inject('/boa.wasm');
    const audit = await app.inject('/boa-audit.json');
    assert.equal(wasm.statusCode, 200);
    assert.equal(audit.statusCode, 200);
    assert.equal(createHash('sha256').update(wasm.rawPayload).digest('hex'), boa.runtimeSha256);
    assert.equal(createHash('sha256').update(audit.rawPayload).digest('hex'), boa.auditSha256);
    const worker = await app.inject('/boa-runner.mjs');
    assert.match(String(worker.headers['content-security-policy']), /'wasm-unsafe-eval'/);
    assert.match(String(worker.headers['content-security-policy']), /connect-src 'self'/);
    assert.match(String(worker.headers['content-security-policy']), /worker-src 'none'/);
    for (const path of ['/', '/runner.mjs']) {
      assert.doesNotMatch(
        String((await app.inject(path)).headers['content-security-policy']),
        /wasm-unsafe-eval/,
      );
    }
    const source = `${'// input line\n'.repeat(4096)}${SOURCE}`;
    assert.ok(Buffer.byteLength(source, 'utf8') > 32_768);
    const responses = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: 'POST',
          url: '/api/compile',
          payload: { source, engine: 'boa' },
        }),
      ),
    );
    const busy = responses.find((response) => response.statusCode === 429);
    const compiled = responses.find((response) => response.statusCode === 200);
    assert.ok(busy);
    assert.equal(busy.json().code, 'BOA_BUSY');
    assert.ok(compiled, responses.map((response) => response.body).join('\n'));
    const result = compiled.json();
    assert.equal(result.engine, 'boa');
    assert.equal(result.envelope.manifest.kind, 'boa-checkpoint');
    assert.equal(result.envelope.manifest.abi, 1);
    assert.equal(result.envelope.manifest.runtimeSha256, boa.runtimeSha256);
    assert.equal(result.metadata.auditSha256, boa.auditSha256);
    assert.equal(result.artifact, undefined);
    assert.equal(result.wrapper, undefined);
    const bytes = new Uint8Array(Buffer.from(result.payload, 'base64'));
    assert.equal(result.envelope.manifest.payloadBytes, bytes.length);
    const runtime = await prepareBoaRuntime(
      new Uint8Array(wasm.rawPayload),
      new Uint8Array(audit.rawPayload),
      {
        runtimeSha256: boa.runtimeSha256!,
        auditSha256: boa.auditSha256!,
      },
    );
    const instance = await instantiateBoaPackage(
      result.envelope,
      bytes,
      trust,
      boa.expected!,
      runtime,
    );
    assert.equal(instance.invoke([123]), 369);
    const tampered = new Uint8Array(bytes);
    tampered[0] = tampered[0]! ^ 1;
    await assert.rejects(
      instantiateBoaPackage(result.envelope, tampered, trust, boa.expected!, runtime),
      /PACKAGE_DIGEST/,
    );
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/compile',
      payload: { source: 'DO_NOT_ECHO_SOURCE !!!', engine: 'boa' },
    });
    assert.equal(invalid.statusCode, 422);
    assert.doesNotMatch(invalid.body, /DO_NOT_ECHO_SOURCE/);
    const imported = await app.inject({
      method: 'POST',
      url: '/api/compile',
      payload: {
        source: 'import fs from "node:fs"; export function main() { return 1; }',
        engine: 'boa',
      },
    });
    assert.equal(imported.statusCode, 422);
  },
);

test('demo signed execution rejects payload and signature changes, stale packages, and context substitution', async (t) => {
  const app = await createDemoServer();
  t.after(() => app.close());
  const compiled = await compileSigned(app);
  const { trust, expected } = await readTrust(app);
  const bytes = new TextEncoder().encode(compiled.payload);
  const now = () => compiled.envelope.manifest.notBefore + 1;
  const tampered = new Uint8Array(bytes);
  tampered[0] = tampered[0]! ^ 1;
  await assert.rejects(
    instantiatePackage(compiled.envelope, tampered, trust, expected, [], { now }),
    /PACKAGE_DIGEST/,
  );
  const signature = compiled.envelope.signature;
  await assert.rejects(
    instantiatePackage(
      { ...compiled.envelope, signature: (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1) },
      bytes,
      trust,
      expected,
      [],
      { now },
    ),
    /PACKAGE_SIGNATURE/,
  );
  await assert.rejects(
    instantiatePackage(compiled.envelope, bytes, trust, expected, [], {
      now: () => compiled.envelope.manifest.expiresAt,
    }),
    /PACKAGE_EXPIRED/,
  );
  for (const context of [
    { ...expected, application: 'another-application' },
    { ...expected, deployment: 'another-deployment' },
    { ...expected, runtimeSha256: '0'.repeat(64) },
  ]) {
    await assert.rejects(
      instantiatePackage(compiled.envelope, bytes, trust, context, [], { now }),
      /PACKAGE_CONTEXT/,
    );
  }
});

test('demo server recreation rotates ephemeral signing trust and deployment', async (t) => {
  const first = await createDemoServer();
  const second = await createDemoServer();
  t.after(async () => {
    await first.close();
    await second.close();
  });
  const compiled = await compileSigned(first);
  const firstTrust = await readTrust(first);
  const secondTrust = await readTrust(second);
  assert.notEqual(firstTrust.trust[0]!.keyId, secondTrust.trust[0]!.keyId);
  assert.notEqual(firstTrust.trust[0]!.jwk.x, secondTrust.trust[0]!.jwk.x);
  assert.notEqual(firstTrust.expected.deployment, secondTrust.expected.deployment);
  assert.equal(firstTrust.expected.runtimeSha256, secondTrust.expected.runtimeSha256);
  await assert.rejects(
    instantiatePackage(
      compiled.envelope,
      new TextEncoder().encode(compiled.payload),
      secondTrust.trust,
      secondTrust.expected,
      [],
      { now: () => compiled.envelope.manifest.notBefore + 1 },
    ),
    /PACKAGE_KEY_UNKNOWN/,
  );
});

test('demo rejects cross-origin, cross-site and non-loopback host requests', async (t) => {
  const app = await createDemoServer();
  t.after(() => app.close());
  for (const headers of [
    { origin: 'https://example.com' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { host: 'attacker.test' },
    { host: '127.0.0.1.attacker.test' },
    { host: 'localhost:99999' },
    { host: 'localhost:00000' },
    { host: '[::1]:0' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/compile',
      payload: { source: SOURCE },
      headers,
    });
    assert.equal(response.statusCode, 403);
  }
  const same = await app.inject({
    method: 'POST',
    url: '/api/compile',
    payload: { source: SOURCE },
    headers: {
      host: '127.0.0.1:4971',
      origin: 'http://127.0.0.1:4971',
      'sec-fetch-site': 'same-origin',
    },
  });
  assert.equal(same.statusCode, 200);
});

test('demo bounds compilation attempts per minute', async (t) => {
  const app = await createDemoServer();
  t.after(() => app.close());
  for (let index = 0; index < 30; index++) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/compile',
      payload: { source: SOURCE },
    });
    assert.equal(response.statusCode, 200);
  }
  const response = await app.inject({
    method: 'POST',
    url: '/api/compile',
    payload: { source: SOURCE },
  });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '60');
});
