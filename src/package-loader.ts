import {
  PackageError,
  readVerifiedPayload,
  verifyPackage,
  type VerificationKey,
} from './package.js';
import {
  LIMITS,
  VaultError,
  type HostFunction,
  type RuntimeOptions,
  type VaultInstance,
} from './register-contract.js';
import { instantiate } from './register-runtime.js';

export interface RegisterPackageExpectation {
  readonly application: string;
  readonly deployment: string;
  readonly runtimeSha256: string;
}

function record(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new PackageError('PACKAGE_PAYLOAD');
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new PackageError('PACKAGE_PAYLOAD');
  const keys = Reflect.ownKeys(input);
  if (keys.length < required.length || keys.length > required.length + optional.length)
    throw new PackageError('PACKAGE_PAYLOAD');
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))
      throw new PackageError('PACKAGE_PAYLOAD');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      throw new PackageError('PACKAGE_PAYLOAD');
    copy[key] = descriptor.value as unknown;
  }
  if (required.some((key) => !(key in copy))) throw new PackageError('PACKAGE_PAYLOAD');
  return copy;
}

function metadata(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new PackageError('PACKAGE_METADATA');
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
    throw new PackageError('PACKAGE_METADATA');
  return descriptor.value as unknown;
}

function hostSnapshot(hosts: readonly HostFunction[]): HostFunction[] {
  if (
    !Array.isArray(hosts) ||
    Object.getPrototypeOf(hosts) !== Array.prototype ||
    hosts.length > LIMITS.imports ||
    Reflect.ownKeys(hosts).length !== hosts.length + 1
  )
    throw new VaultError('INVALID_HOSTS');
  const copy: HostFunction[] = [];
  for (let index = 0; index < hosts.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(hosts, String(index));
    if (
      !descriptor ||
      !('value' in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== 'function'
    )
      throw new VaultError('INVALID_HOSTS');
    copy.push(descriptor.value as HostFunction);
  }
  return copy;
}

/** Authenticates bytes before decoding or creating a register VM instance. */
export async function instantiatePackage(
  envelope: unknown,
  payload: Uint8Array,
  trust: readonly VerificationKey[],
  expected: RegisterPackageExpectation,
  hosts: readonly HostFunction[],
  options: RuntimeOptions = {},
): Promise<VaultInstance> {
  let capabilities: HostFunction[];
  let runtimeOptions: RuntimeOptions;
  let context: RegisterPackageExpectation;
  let now: () => number;
  try {
    capabilities = hostSnapshot(hosts);
    const settings = record(options, [], ['now', 'maxSteps']);
    if ('now' in settings && typeof settings.now !== 'function')
      throw new VaultError('INVALID_OPTIONS');
    now = (settings.now as (() => number) | undefined) ?? Date.now;
    runtimeOptions = { now };
    if ('maxSteps' in settings) {
      if (
        typeof settings.maxSteps !== 'number' ||
        !Number.isSafeInteger(settings.maxSteps) ||
        settings.maxSteps < 1 ||
        settings.maxSteps > LIMITS.steps
      )
        throw new VaultError('INVALID_OPTIONS');
      runtimeOptions.maxSteps = settings.maxSteps;
    }
    const fields = record(expected, ['application', 'deployment', 'runtimeSha256']);
    if (
      typeof fields.application !== 'string' ||
      typeof fields.deployment !== 'string' ||
      typeof fields.runtimeSha256 !== 'string'
    )
      throw new PackageError('PACKAGE_CONTEXT');
    context = {
      application: fields.application,
      deployment: fields.deployment,
      runtimeSha256: fields.runtimeSha256,
    };
  } catch (error) {
    if (error instanceof PackageError || error instanceof VaultError) throw error;
    throw new PackageError('PACKAGE_PAYLOAD');
  }
  const verified = await verifyPackage(
    envelope,
    payload,
    trust,
    { ...context, kind: 'register-module', abi: 1 },
    { now },
  );
  let decoded: Record<string, unknown>;
  try {
    const bytes = readVerifiedPayload(verified);
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    decoded = record(parsed, ['artifact', 'dialect']);
  } catch {
    throw new PackageError('PACKAGE_PAYLOAD');
  }
  if (
    metadata(decoded.artifact, 'epoch') !== verified.manifest.epoch ||
    metadata(decoded.artifact, 'notBefore') !== verified.manifest.notBefore ||
    metadata(decoded.artifact, 'expiresAt') !== verified.manifest.expiresAt ||
    metadata(decoded.dialect, 'epoch') !== verified.manifest.epoch
  )
    throw new PackageError('PACKAGE_METADATA');
  return instantiate(decoded.artifact, decoded.dialect, capabilities, runtimeOptions);
}
