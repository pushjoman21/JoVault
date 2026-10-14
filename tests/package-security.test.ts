import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  MAX_PACKAGE_BYTES,
  PACKAGE_EPOCH_MS,
  PackageError,
  canonicalPackageFrame,
  readVerifiedPayload,
  verifyPackage,
  type PackageExpectation,
  type SignedEnvelope,
  type VerificationKey,
  type VerifiedPackage,
} from '../src/package.js';
import { NodePackageSigner, type PackageSigningContext } from '../src/package-signing.js';

const instant = 12 * PACKAGE_EPOCH_MS;
function fixture() {
  const signer = new NodePackageSigner({ keyId: 'build-key' });
  const payload = new TextEncoder().encode('synthetic test checkpoint');
  const runtimeSha256 = createHash('sha256').update('test runtime').digest('hex');
  const context: PackageSigningContext = {
    kind: 'boa-checkpoint',
    application: 'app',
    deployment: 'preview',
    runtimeSha256,
    abi: 1,
    now: instant,
  };
  const expected: PackageExpectation = {
    application: context.application,
    deployment: context.deployment,
    runtimeSha256,
    kind: context.kind,
    abi: context.abi,
  };
  const key = signer.verificationKey({ notBefore: instant, expiresAt: instant + PACKAGE_EPOCH_MS });
  const envelope = signer.sign(payload, context);
  return { signer, payload, context, expected, key, envelope, options: { now: () => instant } };
}
const error =
  (code: string) =>
  (caught: unknown): boolean =>
    caught instanceof PackageError && caught.code === code && caught.message === code;

test('canonical package frame matches the independent protocol byte sequence', () => {
  const manifest = {
    abi: 1,
    payloadBytes: 3,
    payloadSha256: '1111111111111111111111111111111111111111111111111111111111111111',
    runtimeSha256: '0000000000000000000000000000000000000000000000000000000000000000',
    expiresAt: 1800000,
    notBefore: 1200000,
    epoch: 2,
    deployment: 'west',
    application: 'demo',
    kind: 'register-module' as const,
    format: 'JOVLT-P1' as const,
  };
  const expected =
    '["JoVault signed package JOVLT-P1 Ed25519","golden-key","JOVLT-P1","register-module","demo","west",2,1200000,1800000,"0000000000000000000000000000000000000000000000000000000000000000","1111111111111111111111111111111111111111111111111111111111111111",3,1]';
  assert.deepEqual(
    canonicalPackageFrame(manifest, 'golden-key'),
    new TextEncoder().encode(expected),
  );
});

test('Ed25519 package verifies and exposes only immutable metadata and copied payloads', async () => {
  const { envelope, payload, key, expected, options, signer } = fixture();
  const verified = await verifyPackage(envelope, payload, [key], expected, options);
  assert.deepEqual(verified.copyPayload(), payload);
  assert.deepEqual(readVerifiedPayload(verified), payload);
  verified.copyPayload().fill(0);
  payload.fill(1);
  assert.notDeepEqual(verified.copyPayload(), payload);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.manifest), true);
  assert.equal(Object.isFrozen(key.jwk), true);
  assert.equal('d' in key.jwk, false);
  assert.deepEqual(Object.keys(signer), ['keyId']);
  assert.equal(
    Object.keys(signer).some((name) => /private|secret/i.test(name)),
    false,
  );
  assert.throws(
    () => readVerifiedPayload({ ...verified } as VerifiedPackage),
    error('PACKAGE_UNVERIFIED'),
  );
});

test('signer accepts Ed25519 KeyObjects without exporting private material', async () => {
  const { payload, expected, context, options } = fixture();
  const privateKey = generateKeyPairSync('ed25519').privateKey;
  const signer = new NodePackageSigner({ keyId: 'external-key', privateKey });
  const key = signer.verificationKey({ notBefore: instant, expiresAt: instant + PACKAGE_EPOCH_MS });
  assert.equal(
    (await verifyPackage(signer.sign(payload, context), payload, [key], expected, options)).keyId,
    'external-key',
  );
  assert.throws(
    () =>
      new NodePackageSigner({
        keyId: 'wrong',
        privateKey: generateKeyPairSync('x25519').privateKey,
      }),
    error('PACKAGE_SIGNING_KEY'),
  );
});

test('payload, signature, manifest, runtime, and key identity tampering are rejected', async () => {
  const { envelope, payload, key, expected, options } = fixture();
  const changed = new Uint8Array(payload);
  changed[0] = changed[0]! ^ 1;
  await assert.rejects(
    verifyPackage(envelope, changed, [key], expected, options),
    error('PACKAGE_DIGEST'),
  );
  const signature = (envelope.signature[0] === 'A' ? 'B' : 'A') + envelope.signature.slice(1);
  await assert.rejects(
    verifyPackage({ ...envelope, signature }, payload, [key], expected, options),
    error('PACKAGE_SIGNATURE'),
  );
  const manifest = { ...envelope.manifest, abi: 2 };
  await assert.rejects(
    verifyPackage({ ...envelope, manifest }, payload, [key], { ...expected, abi: 2 }, options),
    error('PACKAGE_SIGNATURE'),
  );
  const runtimeSha256 = createHash('sha256').update('other runtime').digest('hex');
  await assert.rejects(
    verifyPackage(
      { ...envelope, manifest: { ...envelope.manifest, runtimeSha256 } },
      payload,
      [key],
      { ...expected, runtimeSha256 },
      options,
    ),
    error('PACKAGE_SIGNATURE'),
  );
  const alias = { ...key, keyId: 'alias-key' };
  await assert.rejects(
    verifyPackage({ ...envelope, keyId: alias.keyId }, payload, [alias], expected, options),
    error('PACKAGE_SIGNATURE'),
  );
});

test('deployment, application, kind, ABI, and expected runtime are independent context checks', async () => {
  const { envelope, payload, key, expected, options } = fixture();
  for (const patch of [
    { application: 'other' },
    { deployment: 'production' },
    { kind: 'register-module' as const },
    { abi: 2 },
    { runtimeSha256: '0'.repeat(64) },
  ]) {
    await assert.rejects(
      verifyPackage(envelope, payload, [key], { ...expected, ...patch }, options),
      error('PACKAGE_CONTEXT'),
    );
  }
  const { application, deployment, runtimeSha256 } = expected;
  assert.ok(
    await verifyPackage(
      envelope,
      payload,
      [key],
      { application, deployment, runtimeSha256 },
      options,
    ),
  );
});

test('unknown keys, wrong keys, duplicate identifiers, and nonpublic JWKs are rejected', async () => {
  const { envelope, payload, key, expected, options } = fixture();
  await assert.rejects(
    verifyPackage(envelope, payload, [], expected, options),
    error('PACKAGE_KEY_UNKNOWN'),
  );
  const wrongSigner = new NodePackageSigner({ keyId: key.keyId });
  const wrong = wrongSigner.verificationKey({ notBefore: key.notBefore, expiresAt: key.expiresAt });
  await assert.rejects(
    verifyPackage(envelope, payload, [wrong], expected, options),
    error('PACKAGE_SIGNATURE'),
  );
  await assert.rejects(
    verifyPackage(envelope, payload, [key, key], expected, options),
    error('PACKAGE_SCHEMA'),
  );
  for (const jwk of [
    { ...key.jwk, d: 'not-a-private-key' },
    { ...key.jwk, alg: 'EdDSA' },
    { ...key.jwk, crv: 'X25519' },
    { ...key.jwk, x: key.jwk.x + '=' },
  ]) {
    await assert.rejects(
      verifyPackage(envelope, payload, [{ ...key, jwk } as VerificationKey], expected, options),
      error('PACKAGE_SCHEMA'),
    );
  }
});

test('artifact and trust key validity include start and exclude end with no grace', async () => {
  const { envelope, payload, key, expected } = fixture();
  for (const now of [instant, instant + PACKAGE_EPOCH_MS - 1])
    assert.ok(await verifyPackage(envelope, payload, [key], expected, { now: () => now }));
  for (const now of [instant - 1, instant + PACKAGE_EPOCH_MS])
    await assert.rejects(
      verifyPackage(envelope, payload, [key], expected, { now: () => now }),
      error('PACKAGE_EXPIRED'),
    );
  for (const narrowed of [
    { ...key, notBefore: instant + 1 },
    { ...key, expiresAt: instant },
  ]) {
    // Keep an otherwise valid nonempty key interval while testing its boundary.
    const selected =
      narrowed.expiresAt === instant ? { ...narrowed, notBefore: instant - 1 } : narrowed;
    await assert.rejects(
      verifyPackage(envelope, payload, [selected], expected, { now: () => instant }),
      error('PACKAGE_KEY_EXPIRED'),
    );
  }
  let checks = 0;
  await assert.rejects(
    verifyPackage(envelope, payload, [key], expected, {
      now: () => (++checks === 1 ? instant : instant + PACKAGE_EPOCH_MS),
    }),
    error('PACKAGE_EXPIRED'),
  );
  for (const now of [
    () => NaN,
    () => Infinity,
    () => -1,
    () => {
      throw new Error('private clock message');
    },
  ])
    await assert.rejects(
      verifyPackage(envelope, payload, [key], expected, { now }),
      error('PACKAGE_CLOCK'),
    );
});

test('all input snapshots finish before the first async crypto operation', async () => {
  const f = fixture();
  const envelope = structuredClone(f.envelope);
  const key = structuredClone(f.key);
  const expected = { ...f.expected };
  const options = { ...f.options };
  const original = new Uint8Array(f.payload);
  const pending = verifyPackage(envelope, f.payload, [key], expected, options);
  Object.assign(envelope.manifest, { application: 'mutated', payloadSha256: '0'.repeat(64) });
  Object.assign(envelope, { keyId: 'mutated', signature: 'A'.repeat(86) });
  Object.assign(key.jwk, { x: 'A'.repeat(43) });
  Object.assign(key, { expiresAt: instant - 1 });
  expected.application = 'mutated';
  options.now = () => instant + PACKAGE_EPOCH_MS;
  f.payload.fill(0);
  const verified = await pending;
  assert.deepEqual(verified.copyPayload(), original);
  assert.equal(verified.manifest.application, 'app');
  assert.equal(verified.keyId, 'build-key');
});

test('exact schemas reject inherited fields, accessors, hidden and symbol extras', async () => {
  const { envelope, payload, key, expected, options } = fixture();
  let accessed = false;
  const getter = { ...envelope };
  Object.defineProperty(getter, 'manifest', {
    enumerable: true,
    get: () => {
      accessed = true;
      return envelope.manifest;
    },
  });
  const hidden = { ...envelope };
  Object.defineProperty(hidden, 'extra', { value: true });
  const symbol = { ...envelope, [Symbol('extra')]: true };
  for (const input of [
    Object.assign(Object.create({ inherited: true }) as object, envelope),
    getter,
    hidden,
    symbol,
    { ...envelope, extra: true },
    { ...envelope, manifest: { ...envelope.manifest, extra: true } },
  ]) {
    await assert.rejects(
      verifyPackage(input, payload, [key], expected, options),
      error('PACKAGE_SCHEMA'),
    );
  }
  assert.equal(accessed, false);
  await assert.rejects(
    verifyPackage(envelope, payload, new Array<VerificationKey>(1), expected, options),
    error('PACKAGE_SCHEMA'),
  );
});

test('size, exact epoch windows, identifiers and canonical encodings are bounded', async () => {
  const { envelope, payload, key, expected, options, signer, context } = fixture();
  await assert.rejects(
    verifyPackage(envelope, payload.subarray(1), [key], expected, options),
    error('PACKAGE_SIZE'),
  );
  const tooLarge = new Uint8Array(MAX_PACKAGE_BYTES + 1);
  assert.throws(() => signer.sign(tooLarge, context), error('PACKAGE_SIZE'));
  await assert.rejects(
    verifyPackage(envelope, tooLarge, [key], expected, options),
    error('PACKAGE_SIZE'),
  );
  for (const patch of [
    { notBefore: instant + 1 },
    { expiresAt: instant + PACKAGE_EPOCH_MS + 1 },
    { payloadBytes: MAX_PACKAGE_BYTES + 1 },
    { application: '' },
    { deployment: 'bad\nname' },
    { abi: 0 },
    { abi: 65536 },
    { epoch: 1.5 },
    { payloadSha256: 'A'.repeat(64) },
  ]) {
    await assert.rejects(
      verifyPackage(
        { ...envelope, manifest: { ...envelope.manifest, ...patch } },
        payload,
        [key],
        expected,
        options,
      ),
      error('PACKAGE_SCHEMA'),
    );
  }
  await assert.rejects(
    verifyPackage(
      { ...envelope, signature: envelope.signature + '=' },
      payload,
      [key],
      expected,
      options,
    ),
    error('PACKAGE_SCHEMA'),
  );
  assert.notDeepEqual(
    canonicalPackageFrame(envelope.manifest, 'a'),
    canonicalPackageFrame(envelope.manifest, 'b'),
  );
  const reordered = Object.fromEntries(Object.entries(envelope.manifest).reverse());
  assert.deepEqual(
    canonicalPackageFrame(reordered as unknown as SignedEnvelope['manifest'], envelope.keyId),
    canonicalPackageFrame(envelope.manifest, envelope.keyId),
  );
});

test('payload snapshots reject shared storage and ignore subclass accessors and iterators', async () => {
  const { signer, context, expected, options, key } = fixture();
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  assert.throws(() => signer.sign(shared, context), error('PACKAGE_SIZE'));
  class SharedDisguise extends Uint8Array {
    override get buffer(): ArrayBuffer {
      return new ArrayBuffer(4);
    }
  }
  const disguised = new Uint8Array(new SharedArrayBuffer(4));
  Object.setPrototypeOf(disguised, SharedDisguise.prototype);
  assert.throws(() => signer.sign(disguised, context), error('PACKAGE_SIZE'));
  let accessed = false;
  const bytes = new Uint8Array([1, 2, 3]);
  Object.defineProperty(bytes, 'buffer', {
    get: () => {
      accessed = true;
      throw new Error('untrusted getter');
    },
  });
  Object.defineProperty(bytes, Symbol.iterator, {
    value: () => {
      accessed = true;
      throw new Error('untrusted iterator');
    },
  });
  const envelope = signer.sign(bytes, context);
  const verified = await verifyPackage(envelope, bytes, [key], expected, options);
  assert.deepEqual(verified.copyPayload(), new Uint8Array([1, 2, 3]));
  assert.equal(accessed, false);
  const buffer = Buffer.from([4, 5, 6]);
  const bufferEnvelope = signer.sign(buffer, context);
  assert.deepEqual(
    (await verifyPackage(bufferEnvelope, buffer, [key], expected, options)).copyPayload(),
    new Uint8Array([4, 5, 6]),
  );
});
