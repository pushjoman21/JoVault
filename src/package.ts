export const PACKAGE_FORMAT = 'JOVLT-P1' as const;
export const PACKAGE_EPOCH_MS = 600_000;
export const MAX_PACKAGE_BYTES = 67_108_864;
const MAX_KEYS = 128;
const DOMAIN = 'JoVault signed package JOVLT-P1 Ed25519';

export interface PackageManifest {
  readonly format: typeof PACKAGE_FORMAT;
  readonly kind: 'register-module' | 'boa-checkpoint';
  readonly application: string;
  readonly deployment: string;
  readonly epoch: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly runtimeSha256: string;
  readonly payloadSha256: string;
  readonly payloadBytes: number;
  readonly abi: number;
}

export interface SignedEnvelope {
  readonly manifest: PackageManifest;
  readonly keyId: string;
  readonly signature: string;
}

export interface PublicVerificationJwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
}

export interface VerificationKey {
  readonly keyId: string;
  readonly jwk: PublicVerificationJwk;
  readonly notBefore: number;
  readonly expiresAt: number;
}

export interface PackageExpectation {
  readonly application: string;
  readonly deployment: string;
  readonly runtimeSha256: string;
  readonly kind?: PackageManifest['kind'];
  readonly abi?: number;
}

export interface PackageVerificationOptions {
  readonly now?: () => number;
}

const verifiedBrand: unique symbol = Symbol('verified-package');
export interface VerifiedPackage {
  readonly [verifiedBrand]: true;
  readonly manifest: PackageManifest;
  readonly keyId: string;
  copyPayload(): Uint8Array<ArrayBuffer>;
}

export class PackageError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PackageError';
  }
}

function fail(code: string): never {
  throw new PackageError(code);
}

function integer(input: unknown, minimum: number, maximum: number): number {
  if (
    typeof input !== 'number' ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  )
    fail('PACKAGE_SCHEMA');
  return input;
}

function record(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('PACKAGE_SCHEMA');
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail('PACKAGE_SCHEMA');
  const keys = Reflect.ownKeys(input);
  if (keys.length < required.length || keys.length > required.length + optional.length)
    fail('PACKAGE_SCHEMA');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))
      fail('PACKAGE_SCHEMA');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('PACKAGE_SCHEMA');
    result[key] = descriptor.value as unknown;
  }
  if (required.some((key) => !(key in result))) fail('PACKAGE_SCHEMA');
  return result;
}

export function packageIdentifier(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input))
    fail('PACKAGE_SCHEMA');
  return input;
}

function digest(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) fail('PACKAGE_SCHEMA');
  return input;
}

function kind(input: unknown): PackageManifest['kind'] {
  if (input !== 'register-module' && input !== 'boa-checkpoint') fail('PACKAGE_SCHEMA');
  return input;
}

export function snapshotManifest(input: unknown): PackageManifest {
  const data = record(input, [
    'format',
    'kind',
    'application',
    'deployment',
    'epoch',
    'notBefore',
    'expiresAt',
    'runtimeSha256',
    'payloadSha256',
    'payloadBytes',
    'abi',
  ]);
  if (data.format !== PACKAGE_FORMAT) fail('PACKAGE_SCHEMA');
  const epoch = integer(
    data.epoch,
    0,
    Math.floor((Number.MAX_SAFE_INTEGER - PACKAGE_EPOCH_MS) / PACKAGE_EPOCH_MS),
  );
  const notBefore = integer(data.notBefore, 0, Number.MAX_SAFE_INTEGER);
  const expiresAt = integer(data.expiresAt, 0, Number.MAX_SAFE_INTEGER);
  if (notBefore !== epoch * PACKAGE_EPOCH_MS || expiresAt !== notBefore + PACKAGE_EPOCH_MS)
    fail('PACKAGE_SCHEMA');
  return Object.freeze({
    format: PACKAGE_FORMAT,
    kind: kind(data.kind),
    application: packageIdentifier(data.application),
    deployment: packageIdentifier(data.deployment),
    epoch,
    notBefore,
    expiresAt,
    runtimeSha256: digest(data.runtimeSha256),
    payloadSha256: digest(data.payloadSha256),
    payloadBytes: integer(data.payloadBytes, 0, MAX_PACKAGE_BYTES),
    abi: integer(data.abi, 1, 65535),
  });
}

export function canonicalPackageFrame(
  manifest: PackageManifest,
  keyId: string,
): Uint8Array<ArrayBuffer> {
  const m = snapshotManifest(manifest);
  return new TextEncoder().encode(
    JSON.stringify([
      DOMAIN,
      packageIdentifier(keyId),
      m.format,
      m.kind,
      m.application,
      m.deployment,
      m.epoch,
      m.notBefore,
      m.expiresAt,
      m.runtimeSha256,
      m.payloadSha256,
      m.payloadBytes,
      m.abi,
    ]),
  );
}

export function encodePackageBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(input: unknown, length: number): Uint8Array<ArrayBuffer> {
  if (
    typeof input !== 'string' ||
    input.length !== Math.ceil((length * 8) / 6) ||
    !/^[A-Za-z0-9_-]+$/.test(input)
  )
    fail('PACKAGE_SCHEMA');
  const binary = atob(input.replace(/-/g, '+').replace(/_/g, '/'));
  const result = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (result.length !== length || encodePackageBase64Url(result) !== input) fail('PACKAGE_SCHEMA');
  return result;
}

export function snapshotPublicVerificationJwk(input: unknown): PublicVerificationJwk {
  const data = record(input, ['kty', 'crv', 'x']);
  if (data.kty !== 'OKP' || data.crv !== 'Ed25519') fail('PACKAGE_SCHEMA');
  decode(data.x, 32);
  return Object.freeze({ kty: 'OKP', crv: 'Ed25519', x: data.x as string });
}

function trustSnapshot(input: unknown): VerificationKey[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > MAX_KEYS ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    fail('PACKAGE_SCHEMA');
  const names = new Set<string>();
  const result: VerificationKey[] = [];
  for (let index = 0; index < input.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(input, String(index));
    if (!entry || !('value' in entry) || !entry.enumerable) fail('PACKAGE_SCHEMA');
    const data = record(entry.value as unknown, ['keyId', 'jwk', 'notBefore', 'expiresAt']);
    const keyId = packageIdentifier(data.keyId);
    if (names.has(keyId)) fail('PACKAGE_SCHEMA');
    names.add(keyId);
    const notBefore = integer(data.notBefore, 0, Number.MAX_SAFE_INTEGER);
    const expiresAt = integer(data.expiresAt, notBefore + 1, Number.MAX_SAFE_INTEGER);
    result.push(
      Object.freeze({ keyId, jwk: snapshotPublicVerificationJwk(data.jwk), notBefore, expiresAt }),
    );
  }
  return result;
}

const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedKind = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;

export function snapshotPackagePayload(input: Uint8Array): Uint8Array<ArrayBuffer> {
  try {
    if (typedKind.call(input) !== 'Uint8Array') fail('PACKAGE_SIZE');
    const buffer: unknown = typedBuffer.call(input);
    const offset: unknown = typedOffset.call(input);
    const length: unknown = typedLength.call(input);
    if (
      !(buffer instanceof ArrayBuffer) ||
      typeof offset !== 'number' ||
      typeof length !== 'number' ||
      length > MAX_PACKAGE_BYTES
    )
      fail('PACKAGE_SIZE');
    // Intrinsic getters avoid subclass accessors; shared storage cannot race this snapshot.
    return new Uint8Array(new Uint8Array(buffer, offset, length));
  } catch {
    return fail('PACKAGE_SIZE');
  }
}

function time(now: () => number): number {
  let instant: unknown;
  try {
    instant = now();
  } catch {
    fail('PACKAGE_CLOCK');
  }
  if (typeof instant !== 'number' || !Number.isFinite(instant) || instant < 0)
    fail('PACKAGE_CLOCK');
  return instant;
}

function checkWindow(manifest: PackageManifest, key: VerificationKey, now: () => number): void {
  const instant = time(now);
  if (instant < manifest.notBefore || instant >= manifest.expiresAt) fail('PACKAGE_EXPIRED');
  if (instant < key.notBefore || instant >= key.expiresAt) fail('PACKAGE_KEY_EXPIRED');
}

const verifiedPayloads = new WeakMap<object, Uint8Array<ArrayBuffer>>();

/** A loader must use this brand check rather than accepting a structurally similar object. */
export function readVerifiedPayload(input: VerifiedPackage): Uint8Array<ArrayBuffer> {
  const payload = verifiedPayloads.get(input);
  if (!payload) fail('PACKAGE_UNVERIFIED');
  return new Uint8Array(payload);
}

export async function verifyPackage(
  envelope: unknown,
  payload: Uint8Array,
  trust: readonly VerificationKey[],
  expected: PackageExpectation,
  options: PackageVerificationOptions = {},
): Promise<VerifiedPackage> {
  let manifest: PackageManifest;
  let keyId: string;
  let signature: Uint8Array<ArrayBuffer>;
  let bytes: Uint8Array<ArrayBuffer>;
  let key: VerificationKey;
  let now: () => number;
  try {
    const data = record(envelope, ['manifest', 'keyId', 'signature']);
    manifest = snapshotManifest(data.manifest);
    keyId = packageIdentifier(data.keyId);
    signature = decode(data.signature, 64);
    bytes = snapshotPackagePayload(payload);
    if (bytes.length !== manifest.payloadBytes) fail('PACKAGE_SIZE');
    const keys = trustSnapshot(trust);
    const found = keys.find((item) => item.keyId === keyId);
    if (!found) fail('PACKAGE_KEY_UNKNOWN');
    key = found;
    const context = record(
      expected,
      ['application', 'deployment', 'runtimeSha256'],
      ['kind', 'abi'],
    );
    if (
      packageIdentifier(context.application) !== manifest.application ||
      packageIdentifier(context.deployment) !== manifest.deployment ||
      digest(context.runtimeSha256) !== manifest.runtimeSha256
    )
      fail('PACKAGE_CONTEXT');
    if ('kind' in context && kind(context.kind) !== manifest.kind) fail('PACKAGE_CONTEXT');
    if ('abi' in context && integer(context.abi, 1, 65535) !== manifest.abi)
      fail('PACKAGE_CONTEXT');
    const settings = record(options, [], ['now']);
    if ('now' in settings && typeof settings.now !== 'function') fail('PACKAGE_SCHEMA');
    now = (settings.now as (() => number) | undefined) ?? Date.now;
    checkWindow(manifest, key, now);
  } catch (error) {
    if (error instanceof PackageError) throw error;
    return fail('PACKAGE_SCHEMA');
  }
  try {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== manifest.payloadSha256) fail('PACKAGE_DIGEST');
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { ...key.jwk },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signature,
      canonicalPackageFrame(manifest, keyId),
    );
    if (!valid) fail('PACKAGE_SIGNATURE');
  } catch (error) {
    if (error instanceof PackageError) throw error;
    return fail('PACKAGE_CRYPTO');
  }
  checkWindow(manifest, key, now);
  const result: VerifiedPackage = Object.freeze({
    [verifiedBrand]: true as const,
    manifest,
    keyId,
    copyPayload(): Uint8Array<ArrayBuffer> {
      return readVerifiedPayload(result);
    },
  });
  verifiedPayloads.set(result, bytes);
  return result;
}
