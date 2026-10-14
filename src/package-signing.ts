import { createHash, createPublicKey, generateKeyPairSync, KeyObject, sign } from 'node:crypto';
import {
  PACKAGE_EPOCH_MS,
  PACKAGE_FORMAT,
  PackageError,
  canonicalPackageFrame,
  encodePackageBase64Url,
  packageIdentifier,
  snapshotManifest,
  snapshotPackagePayload,
  snapshotPublicVerificationJwk,
  type PackageManifest,
  type SignedEnvelope,
  type VerificationKey,
} from './package.js';

export interface PackageSigningContext {
  readonly kind: PackageManifest['kind'];
  readonly application: string;
  readonly deployment: string;
  readonly runtimeSha256: string;
  readonly abi: number;
  readonly now?: number;
}

export interface PackageSignerOptions {
  readonly keyId: string;
  readonly privateKey?: KeyObject;
}

export class NodePackageSigner {
  #privateKey: KeyObject;
  #publicKey: KeyObject;
  readonly keyId: string;

  constructor(options: PackageSignerOptions) {
    this.keyId = packageIdentifier(options.keyId);
    const privateKey = options.privateKey ?? generateKeyPairSync('ed25519').privateKey;
    if (
      !(privateKey instanceof KeyObject) ||
      privateKey.type !== 'private' ||
      privateKey.asymmetricKeyType !== 'ed25519'
    )
      throw new PackageError('PACKAGE_SIGNING_KEY');
    this.#privateKey = privateKey;
    this.#publicKey = createPublicKey(privateKey);
    Object.freeze(this);
  }

  verificationKey(window: {
    readonly notBefore: number;
    readonly expiresAt: number;
  }): VerificationKey {
    if (
      !Number.isSafeInteger(window.notBefore) ||
      window.notBefore < 0 ||
      !Number.isSafeInteger(window.expiresAt) ||
      window.expiresAt <= window.notBefore
    )
      throw new PackageError('PACKAGE_SCHEMA');
    const exported = this.#publicKey.export({ format: 'jwk' });
    const jwk = snapshotPublicVerificationJwk({
      kty: exported.kty,
      crv: exported.crv,
      x: exported.x,
    });
    return Object.freeze({
      keyId: this.keyId,
      jwk,
      notBefore: window.notBefore,
      expiresAt: window.expiresAt,
    });
  }

  sign(payload: Uint8Array, context: PackageSigningContext): SignedEnvelope {
    const bytes = snapshotPackagePayload(payload);
    const instant = context.now ?? Date.now();
    if (!Number.isSafeInteger(instant) || instant < 0) throw new PackageError('PACKAGE_CLOCK');
    const epoch = Math.floor(instant / PACKAGE_EPOCH_MS);
    const manifest = snapshotManifest({
      format: PACKAGE_FORMAT,
      kind: context.kind,
      application: context.application,
      deployment: context.deployment,
      epoch,
      notBefore: epoch * PACKAGE_EPOCH_MS,
      expiresAt: (epoch + 1) * PACKAGE_EPOCH_MS,
      runtimeSha256: context.runtimeSha256,
      payloadSha256: createHash('sha256').update(bytes).digest('hex'),
      payloadBytes: bytes.length,
      abi: context.abi,
    });
    const signature = encodePackageBase64Url(
      sign(null, canonicalPackageFrame(manifest, this.keyId), this.#privateKey),
    );
    return Object.freeze({ manifest, keyId: this.keyId, signature });
  }
}
