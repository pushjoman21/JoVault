import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { instantiatePackage } from '../src/package-loader.js';
import { NodePackageSigner, type PackageSigningContext } from '../src/package-signing.js';
import { PackageError, type VerificationKey } from '../src/package.js';
import {
  DIALECT_FORMAT,
  EPOCH_MS,
  FORMAT,
  OPS,
  VaultError,
  type Artifact,
  type Dialect,
  type HostFunction,
  type Instruction,
  type Op,
} from '../src/register-contract.js';

const instant = 12 * EPOCH_MS;
function fixture() {
  const dialect: Dialect = {
    format: DIALECT_FORMAT,
    id: 'loader-test',
    epoch: 12,
    opcodes: OPS.map((_, index) => index + 100),
  };
  const i = (op: Op, dst = 0, a = 0, b = 0, c = 0): Instruction => [
    dialect.opcodes[OPS.indexOf(op)]!,
    dst,
    a,
    b,
    c,
  ];
  const artifact: Artifact = {
    format: FORMAT,
    dialect: dialect.id,
    epoch: dialect.epoch,
    notBefore: instant,
    expiresAt: instant + EPOCH_MS,
    constants: [42],
    imports: [],
    functions: [{ parameters: 0, registers: 1, code: [i('constant'), i('return')] }],
    exports: [{ name: 'main', function: 0 }],
  };
  const signer = new NodePackageSigner({ keyId: 'loader-key' });
  const expected = {
    application: 'loader-app',
    deployment: 'preview',
    runtimeSha256: createHash('sha256').update('runtime fixture').digest('hex'),
  };
  const context: PackageSigningContext = {
    ...expected,
    kind: 'register-module',
    abi: 1,
    now: instant,
  };
  const key = signer.verificationKey({ notBefore: instant, expiresAt: instant + EPOCH_MS });
  const encode = (input: unknown) => new TextEncoder().encode(JSON.stringify(input));
  const payload = encode({ artifact, dialect });
  const envelope = signer.sign(payload, context);
  return {
    artifact,
    dialect,
    signer,
    expected,
    context,
    key,
    encode,
    payload,
    envelope,
    i,
    options: { now: () => instant },
  };
}

const packageError =
  (code: string) =>
  (caught: unknown): boolean =>
    caught instanceof PackageError && caught.code === code;
const runtimeError =
  (code: string) =>
  (caught: unknown): boolean =>
    caught instanceof VaultError && caught.code === code;

test('verified register packages execute the signed bytes', async () => {
  const f = fixture();
  const instance = await instantiatePackage(
    f.envelope,
    f.payload,
    [f.key],
    f.expected,
    [],
    f.options,
  );
  assert.equal(instance.invoke('main', []), 42);
  assert.equal(instance.invoke('main', []), 42);
});

test('tampered payloads, signatures, context and loader kind/ABI fail before VM execution', async () => {
  const f = fixture();
  const tampered = new Uint8Array(f.payload);
  tampered[0] = tampered[0]! ^ 1;
  await assert.rejects(
    instantiatePackage(f.envelope, tampered, [f.key], f.expected, [], f.options),
    packageError('PACKAGE_DIGEST'),
  );
  const signature = (f.envelope.signature[0] === 'A' ? 'B' : 'A') + f.envelope.signature.slice(1);
  await assert.rejects(
    instantiatePackage({ ...f.envelope, signature }, f.payload, [f.key], f.expected, [], f.options),
    packageError('PACKAGE_SIGNATURE'),
  );
  await assert.rejects(
    instantiatePackage(
      f.envelope,
      f.payload,
      [f.key],
      { ...f.expected, application: 'other' },
      [],
      f.options,
    ),
    packageError('PACKAGE_CONTEXT'),
  );
  await assert.rejects(
    instantiatePackage(
      f.envelope,
      f.payload,
      [f.key],
      { ...f.expected, deployment: 'other' },
      [],
      f.options,
    ),
    packageError('PACKAGE_CONTEXT'),
  );
  await assert.rejects(
    instantiatePackage(
      f.envelope,
      f.payload,
      [f.key],
      { ...f.expected, runtimeSha256: '0'.repeat(64) },
      [],
      f.options,
    ),
    packageError('PACKAGE_CONTEXT'),
  );
  for (const patch of [{ kind: 'boa-checkpoint' as const }, { abi: 2 }]) {
    const envelope = f.signer.sign(f.payload, { ...f.context, ...patch });
    await assert.rejects(
      instantiatePackage(envelope, f.payload, [f.key], f.expected, [], f.options),
      packageError('PACKAGE_CONTEXT'),
    );
  }
});

test('authenticated malformed UTF8, JSON, top-level schema and bytecode are rejected', async () => {
  const f = fixture();
  for (const payload of [
    new Uint8Array([0xc3, 0x28]),
    new TextEncoder().encode('not JSON or executable source'),
    f.encode({ artifact: f.artifact, dialect: f.dialect, source: 'untrusted code' }),
    f.encode({ artifact: f.artifact }),
    f.encode([f.artifact, f.dialect]),
  ]) {
    const envelope = f.signer.sign(payload, f.context);
    await assert.rejects(
      instantiatePackage(envelope, payload, [f.key], f.expected, [], f.options),
      packageError('PACKAGE_PAYLOAD'),
    );
  }
  f.artifact.functions[0]!.code = [[0, 0, 0, 0, 0]];
  const malformed = f.encode({ artifact: f.artifact, dialect: f.dialect });
  await assert.rejects(
    instantiatePackage(
      f.signer.sign(malformed, f.context),
      malformed,
      [f.key],
      f.expected,
      [],
      f.options,
    ),
    runtimeError('INVALID_ARTIFACT'),
  );
});

test('signed manifest interval and epoch must match both artifact and dialect metadata', async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => {
      f.artifact.epoch++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.notBefore++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.expiresAt++;
    },
    (f: ReturnType<typeof fixture>) => {
      f.dialect.epoch++;
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    const payload = f.encode({ artifact: f.artifact, dialect: f.dialect });
    await assert.rejects(
      instantiatePackage(
        f.signer.sign(payload, f.context),
        payload,
        [f.key],
        f.expected,
        [],
        f.options,
      ),
      packageError('PACKAGE_METADATA'),
    );
  }
});

test('verification and register instantiation use the same clock and have no expiry grace', async () => {
  const f = fixture();
  let checks = 0;
  await assert.rejects(
    instantiatePackage(f.envelope, f.payload, [f.key], f.expected, [], {
      now: () => (++checks === 1 ? instant : instant + EPOCH_MS),
    }),
    packageError('PACKAGE_EXPIRED'),
  );
  checks = 0;
  await assert.rejects(
    instantiatePackage(f.envelope, f.payload, [f.key], f.expected, [], {
      now: () => (++checks < 3 ? instant : instant + EPOCH_MS),
    }),
    runtimeError('EXPIRED'),
  );
  let current = instant;
  const instance = await instantiatePackage(f.envelope, f.payload, [f.key], f.expected, [], {
    now: () => current,
  });
  assert.equal(instance.invoke('main', []), 42);
  current += EPOCH_MS;
  assert.throws(() => instance.invoke('main', []), runtimeError('EXPIRED'));
});

test('trust key expiry during crypto rejects even while the package interval remains valid', async () => {
  const f = fixture();
  const key: VerificationKey = { ...f.key, expiresAt: instant + 1 };
  let checks = 0;
  await assert.rejects(
    instantiatePackage(f.envelope, f.payload, [key], f.expected, [], {
      now: () => (++checks === 1 ? instant : instant + 1),
    }),
    packageError('PACKAGE_KEY_EXPIRED'),
  );
});

test('signed host execution checks time again after host return', async () => {
  const f = fixture();
  f.artifact.imports = [{ source: 'capability', imported: 'advance' }];
  f.artifact.functions[0]!.code = [f.i('host_call'), f.i('return')];
  const payload = f.encode({ artifact: f.artifact, dialect: f.dialect });
  const envelope = f.signer.sign(payload, f.context);
  let current = instant;
  let calls = 0;
  const instance = await instantiatePackage(
    envelope,
    payload,
    [f.key],
    f.expected,
    [
      () => {
        calls++;
        current += EPOCH_MS;
        return 9;
      },
    ],
    { now: () => current },
  );
  assert.throws(() => instance.invoke('main', []), runtimeError('EXPIRED'));
  assert.equal(calls, 1);
});

test('loader snapshots capabilities and runtime options before async verification', async () => {
  const f = fixture();
  f.artifact.imports = [{ source: 'capability', imported: 'read' }];
  f.artifact.functions[0]!.code = [f.i('host_call'), f.i('return')];
  const payload = f.encode({ artifact: f.artifact, dialect: f.dialect });
  const hosts: HostFunction[] = [() => 5];
  const options = { now: () => instant, maxSteps: 2 };
  const pending = instantiatePackage(
    f.signer.sign(payload, f.context),
    payload,
    [f.key],
    f.expected,
    hosts,
    options,
  );
  hosts[0] = () => 999;
  options.now = () => instant + EPOCH_MS;
  options.maxSteps = 1;
  payload.fill(0);
  assert.equal((await pending).invoke('main', []), 5);
});

test('verified packages retain runtime resource budgets', async () => {
  const f = fixture();
  const short = await instantiatePackage(f.envelope, f.payload, [f.key], f.expected, [], {
    ...f.options,
    maxSteps: 1,
  });
  assert.throws(() => short.invoke('main', []), runtimeError('STEP_LIMIT'));
  f.artifact.functions[0]!.code = [f.i('jump')];
  const loopPayload = f.encode({ artifact: f.artifact, dialect: f.dialect });
  const loop = await instantiatePackage(
    f.signer.sign(loopPayload, f.context),
    loopPayload,
    [f.key],
    f.expected,
    [],
    { ...f.options, maxSteps: 3 },
  );
  assert.throws(() => loop.invoke('main', []), runtimeError('STEP_LIMIT'));
  assert.throws(() => loop.invoke('main', []), runtimeError('STEP_LIMIT'));
});
